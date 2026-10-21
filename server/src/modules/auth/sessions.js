/**
 * Sessões e CSRF.
 *
 * Por que sessão em banco e não JWT: um JWT roubado vale até expirar e não há
 * como revogá-lo. Num sistema com saldo, isso é inaceitável — precisamos
 * matar a sessão na hora em que o jogador clica "sair de todos os aparelhos"
 * ou em que a conta é congelada por suspeita.
 *
 * O cookie leva apenas um token opaco. No banco fica só o HASH dele, então um
 * dump do banco não dá a ninguém o poder de se passar por um jogador.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, isProd } from '../../config.js';
import { unauthorized, forbidden } from '../../lib/errors.js';
import { serializeCookie } from '../../http/router.js';

export const SESSION_COOKIE = 'lpg_session';
export const CSRF_COOKIE = 'lpg_csrf';

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

export async function createSession(client, { userId, userAgent, ip }) {
  const token = randomBytes(32).toString('base64url');
  const csrfSecret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3_600_000);

  const { rows } = await client.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_secret, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, hashToken(token), csrfSecret, (userAgent ?? '').slice(0, 300), ip ?? null, expiresAt],
  );

  return { id: rows[0].id, token, csrfSecret, expiresAt };
}

/** Busca a sessão viva do token e devolve o usuário junto. */
export async function loadSession(client, token) {
  if (!token || typeof token !== 'string') return null;
  const { rows } = await client.query(
    `SELECT s.id, s.user_id, s.csrf_secret, s.expires_at,
            u.email, u.display_name, u.kyc_level, u.doc_status,
            u.is_admin, u.is_frozen, u.frozen_reason
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!rows[0]) return null;

  // `last_seen_at` é informativo (lista de aparelhos conectados); não deixamos
  // uma falha aqui derrubar a requisição.
  client
    .query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [rows[0].id])
    .catch(() => {});

  return rows[0];
}

export async function revokeSession(client, sessionId) {
  await client.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

/** Derruba todas as sessões do usuário — usado na troca de senha e no congelamento. */
export async function revokeAllSessions(client, userId, { except } = {}) {
  await client.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
    [userId, except ?? null],
  );
}

export async function purgeExpiredSessions(client) {
  const { rowCount } = await client.query(
    `DELETE FROM sessions WHERE expires_at < now() - INTERVAL '30 days'`,
  );
  return rowCount;
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

export function sessionCookies({ token, csrfSecret, expiresAt }) {
  return [
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,            // JavaScript da página nunca lê o token
      secure: isProd,
      sameSite: 'Lax',
      expires: expiresAt,
    }),
    // Este o JavaScript PRECISA ler, para repetir o valor no cabeçalho.
    // É o padrão "double submit": quem está em outro site consegue fazer o
    // navegador enviar o cookie, mas não consegue LER o valor para copiá-lo
    // no cabeçalho — a política de mesma origem impede.
    serializeCookie(CSRF_COOKIE, csrfSecret, {
      httpOnly: false,
      secure: isProd,
      sameSite: 'Lax',
      expires: expiresAt,
    }),
  ];
}

export function clearCookies() {
  const past = new Date(0);
  return [
    serializeCookie(SESSION_COOKIE, '', { httpOnly: true, secure: isProd, expires: past }),
    serializeCookie(CSRF_COOKIE, '', { httpOnly: false, secure: isProd, expires: past }),
  ];
}

/* ------------------------------------------------------------------ */
/* Guardas                                                             */
/* ------------------------------------------------------------------ */

export function requireAuth(ctx) {
  if (!ctx.user) throw unauthorized();
  if (ctx.user.is_frozen) {
    throw forbidden(
      ctx.user.frozen_reason
        ? `Conta temporariamente bloqueada: ${ctx.user.frozen_reason}`
        : 'Conta temporariamente bloqueada. Fale com o suporte.',
    );
  }
  return ctx.user;
}

export function requireAdmin(ctx) {
  const user = requireAuth(ctx);
  if (!user.is_admin) throw forbidden();
  return user;
}

/**
 * Confere o token CSRF em toda requisição que muda estado.
 *
 * Sem isso, um site malicioso poderia fazer o navegador do jogador enviar
 * `POST /api/withdrawals` com o cookie de sessão junto. O `SameSite=Lax` já
 * barra a maioria dos casos; este é o cinto sobre o suspensório.
 */
export function verifyCsrf(ctx) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) return;
  if (!ctx.session) return; // rota pública: não há sessão para proteger

  const sent = ctx.req.headers['x-csrf-token'];
  const expected = ctx.session.csrf_secret;
  if (typeof sent !== 'string' || !sent || !expected) {
    throw forbidden('Token de verificação ausente. Recarregue a página.');
  }
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw forbidden('Token de verificação inválido. Recarregue a página.');
  }
}

/**
 * Checagem de origem, independente do CSRF.
 * Requisição que muda estado tem que vir do nosso próprio site.
 */
export function verifyOrigin(ctx) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) return;
  const origin = ctx.req.headers.origin;
  if (!origin) return; // clientes não-navegador (curl, app) não mandam Origin
  let allowed;
  try {
    allowed = new URL(config.PUBLIC_URL).origin;
  } catch {
    return;
  }
  if (origin !== allowed) throw forbidden('Origem não autorizada.');
}
