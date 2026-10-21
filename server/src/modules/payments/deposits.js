/**
 * Depósitos.
 *
 * O fluxo correto, e por que cada passo existe:
 *
 *   1. O jogador pede uma cobrança. Nós gravamos `deposits` como `pending` e
 *      NÃO creditamos nada. Saldo só existe depois que o dinheiro entrou.
 *   2. O provedor devolve o código Pix. O jogador paga no banco dele.
 *   3. O provedor chama nosso webhook. Conferimos a assinatura, consultamos
 *      o pagamento na API do provedor com nossa própria credencial, e só
 *      então creditamos — dentro de uma transação, com chave de idempotência.
 *
 * O protótipo creditava no passo 1 (`setTimeout` e `balance += amount`).
 * Isto aqui é a diferença entre um jogo de demonstração e um sistema que
 * movimenta dinheiro.
 */

import { config } from '../../config.js';
import { withTransaction, withRetryableTransaction } from '../../db/pool.js';
import { badRequest, notFound, conflict, AppError } from '../../lib/errors.js';
import { requirePositiveCents, formatBRL } from '../../lib/money.js';
import * as ledger from '../wallet/ledger.js';
import { PAYMENT_STATUS } from './provider.js';
import { checkDepositAllowed } from '../users/responsible-gaming.js';

/**
 * Cria uma cobrança Pix.
 * Nada de dinheiro se move aqui — só nasce um registro `pending`.
 */
export async function createDeposit({ provider, userId, amountInput }) {
  const amountCents = requirePositiveCents(amountInput, {
    min: config.MIN_DEPOSIT_CENTS,
    max: config.MAX_DEPOSIT_CENTS,
    label: 'depósito',
  });

  // Limites de jogo responsável valem ANTES de criar a cobrança, para o
  // jogador não pagar um Pix que depois seria recusado.
  const deposit = await withTransaction(async (client) => {
    const { rows: userRows } = await client.query(
      `SELECT id, email, full_name, cpf_last3, is_frozen FROM users WHERE id = $1`,
      [userId],
    );
    const user = userRows[0];
    if (!user) throw notFound('Usuário não encontrado.');
    if (user.is_frozen) throw badRequest('Conta bloqueada. Fale com o suporte.');

    await checkDepositAllowed(client, userId, amountCents);

    // Muitas cobranças pendentes abertas é sinal de abuso ou de interface
    // travada; de qualquer forma não é para acumular.
    const { rows: pending } = await client.query(
      `SELECT count(*)::int AS n FROM deposits
        WHERE user_id = $1 AND status = 'pending' AND expires_at > now()`,
      [userId],
    );
    if (pending[0].n >= 5) {
      throw conflict('Você tem cobranças pendentes demais. Pague ou espere expirarem.');
    }

    const { rows } = await client.query(
      `INSERT INTO deposits (user_id, amount_cents, provider, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id, amount_cents, created_at`,
      [userId, amountCents, provider.name],
    );
    return { ...rows[0], email: user.email, fullName: user.full_name };
  });

  // A chamada ao provedor fica FORA da transação: uma chamada de rede dentro
  // de transação segura conexão do banco por segundos e trava o pool.
  let charge;
  try {
    charge = await provider.createPixCharge({
      amountCents,
      depositId: deposit.id,
      payer: { email: deposit.email, firstName: deposit.fullName?.split(' ')[0] },
      expiresInSeconds: 1800,
    });
  } catch (err) {
    await withTransaction((client) =>
      client.query(`UPDATE deposits SET status = 'failed', updated_at = now() WHERE id = $1`, [deposit.id]),
    ).catch(() => {});
    throw err;
  }

  await withTransaction((client) =>
    client.query(
      `UPDATE deposits SET provider_charge_id = $2, pix_copy_paste = $3,
                           pix_qr_code = $4, expires_at = $5, updated_at = now()
        WHERE id = $1`,
      [deposit.id, charge.providerChargeId, charge.copyPaste, charge.qrCodeBase64, charge.expiresAt],
    ),
  );

  return {
    id: deposit.id,
    amountCents,
    status: 'pending',
    pixCopyPaste: charge.copyPaste,
    pixQrCodeBase64: charge.qrCodeBase64,
    expiresAt: charge.expiresAt,
  };
}

/**
 * Confirma um depósito pago. Chamado SÓ pelo processador de webhook, depois
 * de a assinatura ter sido verificada.
 *
 * Idempotente em dois níveis: a transição de status só acontece se o depósito
 * ainda estiver `pending`, e o lançamento no razão tem chave única.
 */
export async function confirmDeposit({ depositId, providerChargeId, paidAmountCents }) {
  return withRetryableTransaction(async (client) => {
    // FOR UPDATE: dois webhooks simultâneos do mesmo pagamento se enfileiram
    // aqui, e o segundo vai encontrar o depósito já como 'paid'.
    const { rows } = await client.query(
      `SELECT id, user_id, amount_cents, status FROM deposits
        WHERE ($1::uuid IS NOT NULL AND id = $1)
           OR ($2::text IS NOT NULL AND provider_charge_id = $2)
        FOR UPDATE`,
      [depositId ?? null, providerChargeId ?? null],
    );
    const deposit = rows[0];
    if (!deposit) throw notFound('Depósito não encontrado.');

    if (deposit.status === 'paid') {
      return { alreadyProcessed: true, depositId: deposit.id };
    }
    if (deposit.status !== 'pending') {
      throw conflict(`Depósito em estado ${deposit.status}, não pode ser confirmado.`);
    }

    // Trava central contra fraude de valor: o que creditamos é o que foi
    // COBRADO, e só se o provedor confirmar que foi isso que entrou.
    if (paidAmountCents !== deposit.amount_cents) {
      await client.query(
        `UPDATE deposits SET status = 'failed', updated_at = now() WHERE id = $1`,
        [deposit.id],
      );
      await audit(client, {
        action: 'deposit.amount_mismatch',
        targetId: deposit.id,
        detail: { expected: deposit.amount_cents, received: paidAmountCents },
      });
      throw new AppError(
        `Valor pago (${formatBRL(paidAmountCents)}) não bate com o cobrado (${formatBRL(deposit.amount_cents)}).`,
        { statusCode: 409, code: 'amount_mismatch', expose: false },
      );
    }

    const walletId = await ledger.ensureUserAccount(client, deposit.user_id);
    const gatewayId = await ledger.systemAccountId(client, 'pix_gateway');

    const { transactionId } = await ledger.transfer(client, {
      fromAccountId: gatewayId,  // o dinheiro vem do mundo externo
      toAccountId: walletId,
      amountCents: deposit.amount_cents,
      reason: 'deposit',
      idempotencyKey: `deposit:${deposit.id}`,
      referenceType: 'deposit',
      referenceId: deposit.id,
      memo: 'Depósito via Pix',
    });

    await client.query(
      `UPDATE deposits SET status = 'paid', paid_at = now(), ledger_tx_id = $2, updated_at = now()
        WHERE id = $1`,
      [deposit.id, transactionId],
    );

    await audit(client, {
      actorId: deposit.user_id,
      action: 'deposit.confirmed',
      targetType: 'deposit',
      targetId: deposit.id,
      detail: { amountCents: deposit.amount_cents },
    });

    return {
      alreadyProcessed: false,
      depositId: deposit.id,
      userId: deposit.user_id,
      amountCents: deposit.amount_cents,
    };
  });
}

/** Marca como expiradas as cobranças que passaram do prazo sem pagamento. */
export async function expireStaleDeposits(client) {
  const { rowCount } = await client.query(
    `UPDATE deposits SET status = 'expired', updated_at = now()
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()`,
  );
  return rowCount;
}

export async function listDeposits(client, userId, limit = 20) {
  const { rows } = await client.query(
    `SELECT id, amount_cents, status, created_at, paid_at, expires_at
       FROM deposits WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 100)],
  );
  return rows;
}

async function audit(client, { actorId, action, targetType = 'deposit', targetId, detail }) {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId ?? null, action, targetType, targetId ?? null, detail ? JSON.stringify(detail) : null],
  );
}
