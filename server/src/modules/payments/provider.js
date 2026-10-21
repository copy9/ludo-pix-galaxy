/**
 * Interface do provedor de pagamento.
 *
 * Todo provedor (Mercado Pago, Asaas, Efí/Gerencianet, PSP do seu banco) é
 * plugado implementando este contrato. O resto do sistema não sabe qual é —
 * trocar de provedor é escrever um arquivo em `providers/` e mudar uma
 * variável de ambiente, não mexer na regra de negócio.
 *
 * REGRA INEGOCIÁVEL: a chave de API do provedor vive SÓ neste processo.
 * Ela nunca é enviada ao navegador, nunca aparece em log e nunca volta numa
 * resposta de API. O protótipo não tinha esse problema só porque não tinha
 * provedor nenhum; na primeira integração é o erro mais comum e o mais caro.
 */

/**
 * @typedef {object} PixCharge
 * @property {string} providerChargeId  id da cobrança no provedor
 * @property {string} copyPaste         código Pix copia-e-cola
 * @property {string} [qrCodeBase64]    imagem do QR, se o provedor devolver
 * @property {Date}   expiresAt
 *
 * @typedef {object} PaymentProvider
 * @property {string} name
 * @property {(args: {amountCents, depositId, payer, expiresInSeconds}) => Promise<PixCharge>} createPixCharge
 * @property {(rawBody: Buffer, headers: object) => {valid: boolean, eventId: string, event: object}} verifyWebhook
 * @property {(event: object) => Promise<null | {providerChargeId, status, paidAmountCents}>} parsePaymentEvent
 * @property {(args: {withdrawalId, amountCents, pixKey, pixKeyType, recipientName}) => Promise<{providerPayoutId, status}>} sendPixPayout
 */

/** Estados normalizados que o núcleo entende, qualquer que seja o provedor. */
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  EXPIRED: 'expired',
  FAILED: 'failed',
  REFUNDED: 'refunded',
});

export const PAYOUT_STATUS = Object.freeze({
  PROCESSING: 'processing',
  PAID: 'paid',
  FAILED: 'failed',
});

/** Erro de comunicação com o provedor — distinguimos do erro de validação. */
export class ProviderError extends Error {
  constructor(message, { retryable = false, providerCode } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.providerCode = providerCode;
    this.statusCode = 502;
    // O jogador vê uma mensagem genérica; o detalhe fica no log do servidor.
    this.expose = false;
  }
}

/** Confere na partida que um adaptador implementa tudo que o núcleo chama. */
export function assertValidProvider(provider) {
  const required = ['name', 'createPixCharge', 'verifyWebhook', 'parsePaymentEvent', 'sendPixPayout'];
  for (const key of required) {
    if (provider?.[key] === undefined) {
      throw new Error(`Provedor de pagamento inválido: falta "${key}".`);
    }
  }
  return provider;
}

/**
 * Carrega o adaptador configurado.
 * Import dinâmico para não carregar código de provedor que não vai ser usado.
 */
export async function loadProvider(config) {
  switch (config.PAYMENT_PROVIDER) {
    case 'mercadopago': {
      const { createMercadoPagoProvider } = await import('./providers/mercadopago.js');
      return assertValidProvider(createMercadoPagoProvider(config));
    }
    case 'mock': {
      const { createMockProvider } = await import('./providers/mock.js');
      return assertValidProvider(createMockProvider(config));
    }
    default:
      throw new Error(`Provedor desconhecido: ${config.PAYMENT_PROVIDER}`);
  }
}
