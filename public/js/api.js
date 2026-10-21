/**
 * Cliente da API do Ludo Pix Galaxy.
 *
 * Substitui o `claude.use('db')` e o `claude.use('user')` do protótipo, que
 * davam ao navegador acesso direto ao banco. Aqui o navegador não escreve
 * nada: ele pede, e o servidor decide.
 *
 * Três coisas que este arquivo faz e que o protótipo não fazia:
 *   • manda o token CSRF em toda requisição que muda estado;
 *   • trata erro de forma estruturada, com código, para a interface reagir
 *     (saldo insuficiente é diferente de autoexclusão, que é diferente de
 *     sessão expirada);
 *   • nunca guarda saldo como verdade local — o saldo exibido é sempre o que
 *     a última resposta do servidor disse.
 */

const BASE = '';

/** Erro vindo da API, com o código que a interface usa para decidir o que mostrar. */
export class ApiError extends Error {
  constructor(message, { status, code, detail, issues } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.issues = issues;
  }
  get isAuth() { return this.status === 401; }
  get isInsufficientFunds() { return this.code === 'insufficient_funds'; }
  get isSelfExcluded() { return this.code === 'self_excluded'; }
  get isKycRequired() { return this.code === 'kyc_required'; }
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function request(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (!['GET', 'HEAD'].includes(method)) {
    // Double submit: o servidor compara este cabeçalho com o cookie. Um site
    // de terceiros consegue fazer o navegador enviar o cookie, mas não
    // consegue LER o valor para copiá-lo aqui.
    const csrf = readCookie('lpg_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  // Operações de dinheiro levam chave de idempotência: se a rede cair depois
  // do servidor processar, repetir não cobra nem paga duas vezes.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Não consegui falar com o servidor. Verifique sua conexão.', {
      status: 0, code: 'network',
    });
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!res.ok) {
    throw new ApiError(payload?.error ?? 'Algo deu errado.', {
      status: res.status,
      code: payload?.code,
      detail: payload?.detail,
      issues: payload?.issues,
    });
  }
  return payload ?? {};
}

/** Chave de idempotência nova para cada operação de dinheiro iniciada. */
export function newIdempotencyKey() {
  return crypto.randomUUID();
}

export const api = {
  /* ---------------- conta ---------------- */
  signup: (data) => request('/api/auth/signup', { method: 'POST', body: data }),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  logoutAll: () => request('/api/auth/logout-all', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),

  /* ---------------- perfil e KYC ---------------- */
  getProfile: () => request('/api/me/profile'),
  updateProfile: (data) => request('/api/me/profile', { method: 'PUT', body: data }),
  getLimits: () => request('/api/me/limits'),
  updateLimits: (data) => request('/api/me/limits', { method: 'PUT', body: data }),
  setPause: (hours) => request('/api/me/pause', { method: 'POST', body: { hours } }),
  selfExclude: (days) => request('/api/me/self-exclusion', { method: 'POST', body: { days } }),

  /* ---------------- carteira ---------------- */
  balance: () => request('/api/wallet/balance'),
  statement: (before) => request(`/api/wallet/statement${before ? `?before=${before}` : ''}`),

  createDeposit: (amount, idempotencyKey) =>
    request('/api/deposits', { method: 'POST', body: { amount }, idempotencyKey }),
  getDeposit: (id) => request(`/api/deposits/${encodeURIComponent(id)}`),
  listDeposits: () => request('/api/deposits'),

  requestWithdrawal: (data, idempotencyKey) =>
    request('/api/withdrawals', { method: 'POST', body: data, idempotencyKey }),
  listWithdrawals: () => request('/api/withdrawals'),

  /* ---------------- desafios ---------------- */
  createChallenge: (data, idempotencyKey) =>
    request('/api/challenges', { method: 'POST', body: data, idempotencyKey }),
  getChallenge: (code) => request(`/api/challenges/${encodeURIComponent(code)}`),
  joinChallenge: (code, country, idempotencyKey) =>
    request(`/api/challenges/${encodeURIComponent(code)}/join`, {
      method: 'POST', body: { country }, idempotencyKey,
    }),
  cancelChallenge: (code) =>
    request(`/api/challenges/${encodeURIComponent(code)}/cancel`, { method: 'POST' }),
  myChallenges: () => request('/api/challenges'),

  /* ---------------- partida ---------------- */
  getMatch: (id) => request(`/api/matches/${encodeURIComponent(id)}`),
  roll: (matchId) => request(`/api/matches/${encodeURIComponent(matchId)}/roll`, { method: 'POST' }),
  move: (matchId, tokenIndex) =>
    request(`/api/matches/${encodeURIComponent(matchId)}/move`, { method: 'POST', body: { tokenIndex } }),
  fairness: (matchId) => request(`/api/matches/${encodeURIComponent(matchId)}/fairness`),
};

/**
 * Acompanha a partida em tempo real por SSE.
 *
 * SSE em vez de WebSocket: reconecta sozinho, atravessa proxy corporativo sem
 * configuração e é unidirecional — que é exatamente o que queremos, já que o
 * cliente só manda jogada por POST e nunca empurra estado.
 */
export function watchMatch(matchId, { onState, onEnd, onError } = {}) {
  const source = new EventSource(`/api/matches/${encodeURIComponent(matchId)}/stream`);

  source.addEventListener('state', (ev) => {
    try { onState?.(JSON.parse(ev.data)); } catch { /* ignora quadro malformado */ }
  });
  source.addEventListener('end', (ev) => {
    try { onEnd?.(JSON.parse(ev.data)); } catch { onEnd?.(null); }
    source.close();
  });
  source.onerror = () => {
    // O EventSource tenta reconectar sozinho; só avisamos a interface.
    onError?.(new ApiError('Conexão com a partida caiu. Tentando reconectar…', { code: 'stream' }));
  };

  return { close: () => source.close() };
}

/* ------------------------------------------------------------------ */
/* Utilidades de interface                                             */
/* ------------------------------------------------------------------ */

/** Formata centavos como moeda. O servidor sempre manda centavos inteiros. */
export function formatBRL(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return 'R$ 0,00';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Escapa texto para interpolação em HTML.
 *
 * O `desafio.html` do protótipo não tinha isto e injetava o nome do adversário
 * direto no innerHTML — um jogador com `<img onerror=...>` no nome executava
 * script na tela de quem o desafiasse.
 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Converte o valor digitado pelo usuário em centavos, aceitando vírgula. */
export function parseAmount(input) {
  const raw = String(input ?? '').trim().replace(/^R\$\s*/i, '');
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
