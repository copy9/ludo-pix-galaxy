/**
 * Provedor simulado — APENAS para desenvolvimento e testes.
 *
 * O `config.js` recusa subir em produção com este provedor, porque ele credita
 * saldo sem cobrar ninguém. Essa trava é proposital: um protótipo que "vira"
 * produção com o pagamento ainda simulado é exatamente como se perde dinheiro.
 *
 * Ele implementa o MESMO contrato do provedor real, inclusive assinatura de
 * webhook, para que os testes exercitem o caminho verdadeiro e não um atalho.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PAYMENT_STATUS, PAYOUT_STATUS } from '../provider.js';

export function createMockProvider(config) {
  const secret = config.PAYMENT_WEBHOOK_SECRET ?? 'mock-webhook-secret';
  // Cobranças em memória, para o webhook simulado poder consultá-las.
  const charges = new Map();

  return {
    name: 'mock',

    async createPixCharge({ amountCents, depositId, expiresInSeconds = 1800 }) {
      const providerChargeId = `mock_${randomUUID()}`;
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
      charges.set(providerChargeId, { amountCents, depositId, status: PAYMENT_STATUS.PENDING });
      return {
        providerChargeId,
        // Formato parecido com um Pix copia-e-cola, só para a interface ter o
        // que mostrar. Não é um código válido e não cobra ninguém.
        copyPaste: `00020126MOCK${providerChargeId}5204000053039865802BR6304TEST`,
        qrCodeBase64: null,
        expiresAt,
      };
    },

    verifyWebhook(rawBody, headers) {
      const signature = headers['x-mock-signature'];
      if (typeof signature !== 'string') return { valid: false, eventId: null, event: null };
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      const valid = a.length === b.length && timingSafeEqual(a, b);

      let event = null;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { valid: false, eventId: null, event: null };
      }
      return { valid, eventId: `mock:${event?.id ?? 'sem-id'}`, event };
    },

    async parsePaymentEvent(event) {
      if (!event?.providerChargeId) return null;
      const charge = charges.get(event.providerChargeId);
      return {
        providerChargeId: event.providerChargeId,
        externalReference: charge?.depositId ?? event.externalReference ?? null,
        status: event.status ?? PAYMENT_STATUS.PAID,
        // Usa o valor da cobrança registrada, como o provedor real faria ao
        // ser consultado — não o valor que veio no corpo do webhook.
        paidAmountCents: charge?.amountCents ?? event.paidAmountCents ?? 0,
      };
    },

    async sendPixPayout({ withdrawalId }) {
      return { providerPayoutId: `mock_payout_${withdrawalId}`, status: PAYOUT_STATUS.PROCESSING };
    },

    /** Só no mock: usado pelos testes para simular o pagamento da cobrança. */
    __simulatePayment(providerChargeId, { status = PAYMENT_STATUS.PAID } = {}) {
      const body = Buffer.from(JSON.stringify({ id: randomUUID(), providerChargeId, status }));
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      return { body, headers: { 'x-mock-signature': signature } };
    },
  };
}
