/* Contas e sessoes.
 *
 * Diferencas em relacao ao que havia no perfil.html:
 *  - A senha nao e mais verificada no navegador. O hash nunca sai do servidor.
 *  - scrypt no lugar de um SHA-256 unico. SHA-256 e rapido de proposito, o que
 *    e exatamente o que o atacante quer: uma GPU testa bilhoes por segundo.
 *    scrypt e lento e consome memoria, o que torna o ataque caro.
 *  - Salt vindo do CSPRNG, nao de Math.random().
 *  - O token de sessao e guardado em HASH. Se o banco vazar, os tokens de la
 *    nao servem para entrar em conta nenhuma.
 */
import { db, audit } from './db.js';
import { randomBytes, randomUUID, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

/* Parametros do scrypt.
 * Memoria exigida = 128 * N * r = 128 * 32768 * 8 = 32 MiB.
 * O `maxmem` padrao do Node e exatamente 32 MiB e a checagem interna estoura no
 * limite, entao SEM o maxmem explicito abaixo toda chamada falha com
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS — ou seja, nenhum cadastro funcionaria.
 * N alto de proposito: e o que torna caro quebrar o hash em GPU. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'lpg_session';

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return { salt, hash: hash.toString('hex') };
}

export async function verifyPassword(password, salt, expectedHex) {
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  const expected = Buffer.from(expectedHex, 'hex');
  // Comparacao em tempo constante: um `===` vaza, pelo tempo de resposta,
  // quantos bytes iniciais bateram, e isso permite descobrir o hash byte a byte.
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'A senha precisa de ao menos 8 caracteres.';
  if (pw.length > 200) return 'Senha longa demais.';
  // Lista curta das senhas que aparecem primeiro em qualquer ataque de dicionario.
  const trivial = ['12345678','123456789','senha123','password','qwertyui','11111111','00000000','ludopix1'];
  if (trivial.includes(pw.toLowerCase())) return 'Essa senha e facil demais de adivinhar.';
  return null;
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex');

export function createSession(userId, { userAgent, ip } = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash,user_id,created_at,expires_at,user_agent,ip)
              VALUES (?,?,?,?,?,?)`)
    .run(hashToken(token), userId, now, now + SESSION_TTL_MS, userAgent || null, ip || null);
  return { token, expiresAt: now + SESSION_TTL_MS };
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now());
  return row || null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Derruba todas as sessoes do usuario — usado ao trocar senha. */
export function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function createUser({ email, name, passHash, passSalt }) {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id,email,name,pass_hash,pass_salt,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, email, name, passHash, passSalt, now, now);
  audit(id, 'user.created', { email });
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export const findByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());

/** Middleware: exige sessao valida. */
export function requireAuth(req, res, next) {
  const user = userFromToken(req.cookies?.[SESSION_COOKIE]);
  if (!user) return res.status(401).json({ error: 'nao_autenticado' });
  if (user.status === 'blocked') return res.status(403).json({ error: 'conta_bloqueada' });
  req.user = user;
  next();
}

/** Middleware: bloqueia quem esta em pausa ou autoexclusao (so vale para apostar). */
export function requirePlayable(req, res, next) {
  const now = Date.now();
  if (req.user.excluded_until > now)
    return res.status(403).json({ error: 'autoexcluido', until: req.user.excluded_until });
  if (req.user.paused_until > now)
    return res.status(403).json({ error: 'em_pausa', until: req.user.paused_until });
  next();
}

/** Cookie da sessao. httpOnly impede o JS da pagina (e um XSS) de ler o token. */
export function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: new Date(expiresAt),
    path: '/',
  };
}
