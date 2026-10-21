/**
 * Rotas de pagamento, incluindo o webhook.
 *
 * O webhook é a porta por onde entra dinheiro. Por isso ele:
 *   • não exige sessão (quem chama é o provedor, não o jogador);
 *   • MAS confere a assinatura antes de qualquer processamento;
 *   • grava o evento cru ANTES de processar, para auditoria e reprocessamento;
 *   • usa o id do evento como chave única, então reenvio não paga duas vezes.
 */

import { withTransaction } from '../../db/pool.js';
import { validate, v } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { readRawBody, sendJson } from '../../http/router.js';
import { limits } from '../../http/rate-limit.js';
import { createDeposit, confirmDeposit, listDeposits } from './deposits.js';
import {
  requestWithdrawal, listWithdrawals, reviewQueue, approveWithdrawal, rejectWithdrawal,
} from './withdrawals.js';
import { PAYMENT_STATUS } from './provider.js';

export function registerPaymentRoutes(router, { provider }) {
  /* ---------------- depósitos ---------------- */

  router.post('/api/deposits', async (ctx) => {
    const user = ctx.requireAuth();
    limits.createDeposit(ctx);
    const { amount } = validate(ctx.body, { amount: v.string({ min: 1, max: 20 }) });
    return createDeposit({ provider, userId: user.user_id, amountInput: amount });
  });

  router.get('/api/deposits', async (ctx) => {
    const user = ctx.requireAuth();
    const rows = await withTransaction((client) => listDeposits(client, user.user_id));
    return { deposits: rows.map(publicDeposit) };
  });

  router.get('/api/deposits/:id', async (ctx) => {
    const user = ctx.requireAuth();
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM deposits WHERE id = $1 AND user_id = $2`,
        [ctx.params.id, user.user_id],
      );
      return rows[0];
    });
    if (!row) throw notFound('Depósito não encontrado.');
    return {
      ...publicDeposit(row),
      pixCopyPaste: row.pix_copy_paste,
      pixQrCodeBase64: row.pix_qr_code,
    };
  });

  /* ---------------- saques ---------------- */

  router.post('/api/withdrawals', async (ctx) => {
    const user = ctx.requireAuth();
    limits.withdraw(ctx);
    const data = validate(ctx.body, {
      amount: v.string({ min: 1, max: 20 }),
      pixKeyType: v.enum_(['cpf', 'email', 'phone', 'random']),
      pixKey: v.string({ min: 3, max: 120 }),
      password: v.string({ min: 1, max: 200, trim: false }),
    });
    return requestWithdrawal({ userId: user.user_id, amountInput: data.amount, ...data });
  });

  router.get('/api/withdrawals', async (ctx) => {
    const user = ctx.requireAuth();
    const rows = await withTransaction((client) => listWithdrawals(client, user.user_id));
    return {
      withdrawals: rows.map((r) => ({
        id: r.id,
        amountCents: r.amount_cents,
        status: r.status,
        pixKeyMasked: r.pix_key_masked,
        rejectReason: r.reject_reason,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
      })),
    };
  });

  /* ---------------- administração ---------------- */

  router.get('/api/admin/withdrawals', async (ctx) => {
    ctx.requireAdmin();
    const rows = await withTransaction((client) => reviewQueue(client));
    return { queue: rows };
  });

  router.post('/api/admin/withdrawals/:id/approve', async (ctx) => {
    const admin = ctx.requireAdmin();
    return approveWithdrawal({ provider, withdrawalId: ctx.params.id, adminId: admin.user_id });
  });

  router.post('/api/admin/withdrawals/:id/reject', async (ctx) => {
    const admin = ctx.requireAdmin();
    const { reason } = validate(ctx.body, { reason: v.string({ min: 5, max: 500 }) });
    return rejectWithdrawal({ withdrawalId: ctx.params.id, adminId: admin.user_id, reason });
  });

  /* ---------------- webhook ---------------- */

  router.post(`/api/webhooks/${provider.name}`, async (ctx) => {
    // Lemos os BYTES CRUS: a assinatura é sobre eles. Reserializar o JSON
    // mudaria espaços e ordem de chaves e invalidaria a conferência.
    const raw = await readRawBody(ctx.req);
    const { valid, eventId, event } = provider.verifyWebhook(raw, ctx.req.headers);

    // Grava sempre, válido ou não: um webhook recusado é sinal de ataque ou
    // de segredo desalinhado, e vale a pena ver no histórico.
    await withTransaction((client) =>
      client.query(
        `INSERT INTO payment_webhook_events (provider, provider_event_id, signature_ok, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [provider.name, eventId ?? `invalido:${Date.now()}`, valid, raw.toString('utf8').slice(0, 20000)],
      ),
    ).catch(() => {});

    if (!valid) {
      console.warn(`[webhook] assinatura inválida de ${provider.name} (ip ${ctx.ip})`);
      // 401 sem detalhe: não ajudamos quem está testando forjas.
      sendJson(ctx.res, 401, { error: 'assinatura inválida' });
      return undefined;
    }

    // Já processado? Responde 200 para o provedor parar de reenviar.
    const already = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT processed_at FROM payment_webhook_events
          WHERE provider = $1 AND provider_event_id = $2`,
        [provider.name, eventId],
      );
      return rows[0]?.processed_at != null;
    });
    if (already) {
      sendJson(ctx.res, 200, { ok: true, alreadyProcessed: true });
      return undefined;
    }

    let payment = null;
    try {
      payment = await provider.parsePaymentEvent(event);
    } catch (err) {
      console.error('[webhook] falha ao consultar o pagamento:', err.message);
      // 500 faz o provedor reenviar depois, que é o comportamento correto
      // quando a falha é nossa.
      sendJson(ctx.res, 500, { error: 'falha temporária' });
      return undefined;
    }

    if (payment && payment.status === PAYMENT_STATUS.PAID) {
      try {
        await confirmDeposit({
          depositId: payment.externalReference,
          providerChargeId: payment.providerChargeId,
          paidAmountCents: payment.paidAmountCents,
        });
      } catch (err) {
        await withTransaction((client) =>
          client.query(
            `UPDATE payment_webhook_events SET process_error = $3
              WHERE provider = $1 AND provider_event_id = $2`,
            [provider.name, eventId, String(err.message).slice(0, 500)],
          ),
        ).catch(() => {});
        console.error('[webhook] falha ao confirmar depósito:', err.message);
        sendJson(ctx.res, 200, { ok: false }); // não reenviar: é erro de regra, não transitório
        return undefined;
      }
    }

    await withTransaction((client) =>
      client.query(
        `UPDATE payment_webhook_events SET processed_at = now()
          WHERE provider = $1 AND provider_event_id = $2`,
        [provider.name, eventId],
      ),
    );

    sendJson(ctx.res, 200, { ok: true });
    return undefined;
  });
}

function publicDeposit(r) {
  return {
    id: r.id,
    amountCents: r.amount_cents,
    status: r.status,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    expiresAt: r.expires_at,
  };
}
