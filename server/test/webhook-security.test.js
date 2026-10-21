/**
 * Testes de assinatura de webhook.
 *
 * Esta é a fronteira por onde entra dinheiro. Se ela aceita uma requisição
 * forjada, qualquer pessoa credita o próprio saldo e saca. Os testes abaixo
 * tentam forjar de todas as formas que um atacante tentaria.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMockProvider } from '../src/modules/payments/providers/mock.js';
import { createMercadoPagoProvider } from '../src/modules/payments/providers/mercadopago.js';

const cfg = {
  PAYMENT_WEBHOOK_SECRET: 'segredo-do-webhook-de-teste',
  PAYMENT_API_KEY: 'chave-falsa',
  PUBLIC_URL: 'https://exemplo.test',
};

test('webhook com assinatura correta é aceito', async () => {
  const p = createMockProvider(cfg);
  const charge = await p.createPixCharge({ amountCents: 5000, depositId: 'dep-1' });
  const { body, headers } = p.__simulatePayment(charge.providerChargeId);
  const result = p.verifyWebhook(body, headers);
  assert.equal(result.valid, true);
});

test('webhook sem assinatura é recusado', () => {
  const p = createMockProvider(cfg);
  const body = Buffer.from(JSON.stringify({ providerChargeId: 'x', status: 'paid' }));
  assert.equal(p.verifyWebhook(body, {}).valid, false);
});

test('webhook com assinatura de outro segredo é recusado', async () => {
  const p = createMockProvider(cfg);
  const charge = await p.createPixCharge({ amountCents: 5000, depositId: 'dep-1' });
  const body = Buffer.from(JSON.stringify({ providerChargeId: charge.providerChargeId, status: 'paid' }));
  const forged = createHmac('sha256', 'segredo-errado').update(body).digest('hex');
  assert.equal(p.verifyWebhook(body, { 'x-mock-signature': forged }).valid, false);
});

test('corpo alterado invalida a assinatura', async () => {
  const p = createMockProvider(cfg);
  const charge = await p.createPixCharge({ amountCents: 100, depositId: 'dep-1' });
  const { body, headers } = p.__simulatePayment(charge.providerChargeId);
  // O atacante intercepta e troca o valor por R$ 10.000.
  const tampered = Buffer.from(
    JSON.stringify({ ...JSON.parse(body.toString()), paidAmountCents: 1_000_000 }),
  );
  assert.equal(p.verifyWebhook(tampered, headers).valid, false);
});

test('o valor creditado vem da cobrança registrada, não do corpo do webhook', async () => {
  const p = createMockProvider(cfg);
  const charge = await p.createPixCharge({ amountCents: 500, depositId: 'dep-1' });
  // Mesmo que o corpo alegue um milhão, o provedor devolve o valor real.
  const parsed = await p.parsePaymentEvent({
    providerChargeId: charge.providerChargeId,
    status: 'paid',
    paidAmountCents: 100_000_000,
  });
  assert.equal(parsed.paidAmountCents, 500, 'o valor da cobrança original é que vale');
});

/* ---------------- Mercado Pago ---------------- */

function mpSigned(secret, { dataId, requestId, ts, body }) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  return {
    body: Buffer.from(JSON.stringify(body)),
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
  };
}

test('Mercado Pago: assinatura válida dentro da janela é aceita', () => {
  const p = createMercadoPagoProvider(cfg);
  const ts = Math.floor(Date.now() / 1000);
  const { body, headers } = mpSigned(cfg.PAYMENT_WEBHOOK_SECRET, {
    dataId: '12345', requestId: 'req-1', ts, body: { type: 'payment', data: { id: '12345' } },
  });
  assert.equal(p.verifyWebhook(body, headers).valid, true);
});

test('Mercado Pago: webhook antigo é recusado — barra reenvio capturado', () => {
  const p = createMercadoPagoProvider(cfg);
  const oldTs = Math.floor(Date.now() / 1000) - 3600; // uma hora atrás
  const { body, headers } = mpSigned(cfg.PAYMENT_WEBHOOK_SECRET, {
    dataId: '12345', requestId: 'req-1', ts: oldTs, body: { type: 'payment', data: { id: '12345' } },
  });
  assert.equal(p.verifyWebhook(body, headers).valid, false);
});

test('Mercado Pago: trocar o id do pagamento invalida a assinatura', () => {
  const p = createMercadoPagoProvider(cfg);
  const ts = Math.floor(Date.now() / 1000);
  const signed = mpSigned(cfg.PAYMENT_WEBHOOK_SECRET, {
    dataId: '12345', requestId: 'req-1', ts, body: { type: 'payment', data: { id: '12345' } },
  });
  // Atacante aponta o evento para outro pagamento, mantendo a assinatura.
  const swapped = Buffer.from(JSON.stringify({ type: 'payment', data: { id: '99999' } }));
  assert.equal(p.verifyWebhook(swapped, signed.headers).valid, false);
});

test('Mercado Pago: sem segredo configurado, nada é aceito', () => {
  const p = createMercadoPagoProvider({ ...cfg, PAYMENT_WEBHOOK_SECRET: undefined });
  const ts = Math.floor(Date.now() / 1000);
  const { body, headers } = mpSigned('qualquer', {
    dataId: '1', requestId: 'r', ts, body: { type: 'payment', data: { id: '1' } },
  });
  assert.equal(p.verifyWebhook(body, headers).valid, false, 'falha fechada, não aberta');
});

test('Mercado Pago: cabeçalho malformado não derruba o servidor', () => {
  const p = createMercadoPagoProvider(cfg);
  const body = Buffer.from('{}');
  for (const sig of ['', 'lixo', 'ts=,v1=', 'v1=abc', 'ts=abc,v1=def', 'ts=1,v1=']) {
    assert.doesNotThrow(() => p.verifyWebhook(body, { 'x-signature': sig }));
    assert.equal(p.verifyWebhook(body, { 'x-signature': sig }).valid, false);
  }
});

test('Mercado Pago: corpo que não é JSON é recusado sem lançar', () => {
  const p = createMercadoPagoProvider(cfg);
  const ts = Math.floor(Date.now() / 1000);
  assert.doesNotThrow(() => p.verifyWebhook(Buffer.from('não é json'), { 'x-signature': `ts=${ts},v1=aa` }));
});
