/**
 * Erros da aplicação.
 *
 * Regra central: só vaza para o cliente o que foi marcado como `expose`.
 * Stack trace, mensagem do Postgres e nome de coluna nunca saem — isso é
 * material de reconhecimento para quem está sondando o sistema.
 */

export class AppError extends Error {
  constructor(message, { statusCode = 400, code = 'bad_request', expose = true, detail } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
    this.detail = detail;
  }
}

export const badRequest = (msg, detail) =>
  new AppError(msg, { statusCode: 400, code: 'bad_request', detail });

export const unauthorized = (msg = 'Faça login para continuar.') =>
  new AppError(msg, { statusCode: 401, code: 'unauthorized' });

export const forbidden = (msg = 'Você não tem permissão para isso.') =>
  new AppError(msg, { statusCode: 403, code: 'forbidden' });

export const notFound = (msg = 'Não encontrado.') =>
  new AppError(msg, { statusCode: 404, code: 'not_found' });

export const conflict = (msg) => new AppError(msg, { statusCode: 409, code: 'conflict' });

export const tooMany = (msg = 'Muitas tentativas. Espere um pouco.') =>
  new AppError(msg, { statusCode: 429, code: 'rate_limited' });

/** Saldo insuficiente é tão comum que merece código próprio para a interface. */
export const insufficientFunds = (msg = 'Saldo insuficiente.') =>
  new AppError(msg, { statusCode: 422, code: 'insufficient_funds' });

/** Bloqueio de jogo responsável: a interface precisa tratar diferente. */
export const selfExcluded = (msg, detail) =>
  new AppError(msg, { statusCode: 423, code: 'self_excluded', detail });

export const kycRequired = (msg = 'Verifique sua conta para continuar.') =>
  new AppError(msg, { statusCode: 403, code: 'kyc_required' });
