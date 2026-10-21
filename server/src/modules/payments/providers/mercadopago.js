/**
 * Adaptador do Mercado Pago (Pix).
 *
 * Implementado como referência; se você usa Asaas, Efí ou o PSP do seu banco,
 * copie este arquivo e troque as chamadas — o contrato em `../provider.js` é
 * o mesmo e nada mais no sistema muda.
 *
 * Pontos que costumam dar errado numa integração de Pix e que estão tratados
 * aqui de propósito:
 *
 *  • VALOR EM CENTAVOS vira decimal só na borda, ao montar o JSON. Em nenhum
 *    momento o valor existe como float dentro do nosso código.
 *  • IDEMPOTÊNCIA na criação da cobrança: o id do depósito vai no cabeçalho
 *    `X-Idempotency-Key`, então um retry não cria duas cobranças.
 *  • ASSINATURA DO WEBHOOK conferida em tempo constante antes de qualquer
 *    processamento. Sem isso, qualquer um posta "pagamento aprovado" e credita
 *    saldo de graça — é a falha mais explorada em integração de pagamento.
 *  • O VALOR PAGO é reconferido contra o valor cobrado. Um webhook legítimo
 *    de R$ 1 não pode liberar um depósito de R$ 1.000.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError, PAYMENT_STATUS, PAYOUT_STATUS } from '../provider.js';

const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 15_000;

export function createMercadoPagoProvider(config) {
  const apiKey = config.PAYMENT_API_KEY;
  const webhookSecret = config.PAYMENT_WEBHOOK_SECRET;

  async function call(path, { method = 'GET', body, idempotencyKey } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new ProviderError('Resposta ilegível do provedor.', { retryable: true });
      }
      if (!res.ok) {
        // 5xx e 429 valem retry; 4xx é erro nosso e repetir não resolve.
        const retryable = res.status >= 500 || res.status === 429;
        throw new ProviderError(
          `Mercado Pago respondeu ${res.status}: ${json?.message ?? 'erro'}`,
          { retryable, providerCode: json?.error },
        );
      }
      return json;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err.name === 'AbortError') {
        throw new ProviderError('Tempo esgotado falando com o provedor.', { retryable: true });
      }
      throw new ProviderError(`Falha de rede com o provedor: ${err.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'mercadopago',

    async createPixCharge({ amountCents, depositId, payer, expiresInSeconds = 1800 }) {
      const expires = new Date(Date.now() + expiresInSeconds * 1000);
      // O provedor exige decimal; convertemos aqui, na borda, e só aqui.
      const amount = Number((amountCents / 100).toFixed(2));

      const payload = {
        transaction_amount: amount,
        payment_method_id: 'pix',
        description: 'Depósito Ludo Pix Galaxy',
        external_reference: depositId,
        date_of_expiration: expires.toISOString(),
        notification_url: `${config.PUBLIC_URL}/api/webhooks/mercadopago`,
        payer: {
          email: payer.email,
          first_name: payer.firstName ?? undefined,
          identification: payer.cpf
            ? { type: 'CPF', number: payer.cpf }
            : undefined,
        },
      };

      const res = await call('/v1/payments', {
        method: 'POST',
        body: payload,
        idempotencyKey: `deposit:${depositId}`,
      });

      const tx = res?.point_of_interaction?.transaction_data;
      if (!tx?.qr_code) {
        throw new ProviderError('O provedor não devolveu o código Pix.', { retryable: true });
      }

      return {
        providerChargeId: String(res.id),
        copyPaste: tx.qr_code,
        qrCodeBase64: tx.qr_code_base64 ?? null,
        expiresAt: expires,
      };
    },

    /**
     * Confere a assinatura do webhook.
     * O Mercado Pago assina `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
     * com HMAC-SHA256 e envia em `x-signature: ts=...,v1=...`.
     */
    verifyWebhook(rawBody, headers) {
      const signature = headers['x-signature'];
      const requestId = headers['x-request-id'] ?? '';
      if (typeof signature !== 'string' || !webhookSecret) {
        return { valid: false, eventId: null, event: null };
      }

      const parts = Object.fromEntries(
        signature.split(',').map((p) => {
          const i = p.indexOf('=');
          return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
        }),
      );
      const ts = parts.ts;
      const v1 = parts.v1;
      if (!ts || !v1) return { valid: false, eventId: null, event: null };

      // Janela de 5 minutos: barra reenvio de um webhook antigo capturado.
      const age = Math.abs(Date.now() - Number(ts) * 1000);
      if (!Number.isFinite(age) || age > 5 * 60_000) {
        return { valid: false, eventId: null, event: null, reason: 'timestamp fora da janela' };
      }

      let event;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { valid: false, eventId: null, event: null };
      }

      const dataId = String(event?.data?.id ?? '');
      const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
      const expected = createHmac('sha256', webhookSecret).update(manifest).digest('hex');

      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(v1, 'utf8');
      const valid = a.length === b.length && timingSafeEqual(a, b);

      return {
        valid,
        // Identificador estável do evento, para não processar duas vezes.
        eventId: `${event?.type ?? 'payment'}:${dataId}:${ts}`,
        event,
      };
    },

    /** Busca o pagamento no provedor e normaliza. */
    async parsePaymentEvent(event) {
      if (event?.type !== 'payment' && event?.action !== 'payment.updated') return null;
      const id = event?.data?.id;
      if (!id) return null;

      // Nunca confiamos no valor que veio no corpo do webhook: consultamos a
      // API com nossa própria credencial e usamos a resposta dela.
      const payment = await call(`/v1/payments/${encodeURIComponent(id)}`);

      const map = {
        approved: PAYMENT_STATUS.PAID,
        pending: PAYMENT_STATUS.PENDING,
        in_process: PAYMENT_STATUS.PENDING,
        authorized: PAYMENT_STATUS.PENDING,
        rejected: PAYMENT_STATUS.FAILED,
        cancelled: PAYMENT_STATUS.EXPIRED,
        refunded: PAYMENT_STATUS.REFUNDED,
        charged_back: PAYMENT_STATUS.REFUNDED,
      };

      const paid = payment.transaction_amount;
      return {
        providerChargeId: String(payment.id),
        externalReference: payment.external_reference ?? null,
        status: map[payment.status] ?? PAYMENT_STATUS.PENDING,
        // De volta para centavos, com arredondamento explícito.
        paidAmountCents: Math.round(Number(paid) * 100),
      };
    },

    async sendPixPayout({ withdrawalId, amountCents, pixKey, pixKeyType, recipientName }) {
      const res = await call('/v1/payments', {
        method: 'POST',
        idempotencyKey: `payout:${withdrawalId}`,
        body: {
          transaction_amount: Number((amountCents / 100).toFixed(2)),
          payment_method_id: 'pix',
          external_reference: withdrawalId,
          description: 'Saque Ludo Pix Galaxy',
          payer: { email: 'payouts@ludopixgalaxy.com' },
          additional_info: { pix_key: pixKey, pix_key_type: pixKeyType, recipient: recipientName },
        },
      });
      return {
        providerPayoutId: String(res.id),
        status: res.status === 'approved' ? PAYOUT_STATUS.PAID : PAYOUT_STATUS.PROCESSING,
      };
    },
  };
}
