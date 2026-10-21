/**
 * Hash de senha com scrypt.
 *
 * O protótipo usava SHA-256 com salt de `Math.random()`. Dois problemas
 * sérios, ambos resolvidos aqui:
 *
 *  1. SHA-256 é RÁPIDO. É a qualidade que se quer num checksum e o defeito
 *     fatal num hash de senha: uma GPU testa bilhões por segundo. O scrypt é
 *     deliberadamente lento E consome memória (64 MB por tentativa aqui), o
 *     que torna o ataque em GPU/ASIC caro em vez de trivial.
 *
 *  2. `Math.random()` não é criptográfico — sua saída é previsível a partir
 *     de amostras. Um salt previsível permite tabelas pré-computadas. Aqui o
 *     salt vem de `randomBytes`.
 *
 * O formato guardado carrega os parâmetros, então dá para endurecer o custo
 * no futuro sem invalidar as senhas existentes (ver `needsRehash`).
 */

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// N=2^15, r=8, p=1 → ~64 MB e ~100 ms por hash em hardware de servidor atual.
// `maxmem` precisa ser folgado: o padrão do Node (32 MB) estoura com N=32768.
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 192 * 1024 * 1024 };
const SALT_BYTES = 16;

/** Gera o hash de uma senha. Formato: scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Senha vazia.');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Confere uma senha contra o hash guardado.
 * A comparação é em tempo constante: comparar com `===` vazaria, pelo tempo
 * de resposta, quantos bytes iniciais estavam certos.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Teto defensivo: um hash adulterado no banco com N gigante viraria um
  // travamento do processo a cada tentativa de login.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let expected;
  let salt;
  try {
    expected = Buffer.from(hashB64, 'base64url');
    salt = Buffer.from(saltB64, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;

  let derived;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N, r, p, maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Diz se o hash foi gerado com parâmetros mais fracos que os atuais. */
export function needsRehash(stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

/**
 * Hash determinístico para identificadores sensíveis (CPF, chave Pix).
 *
 * Aqui NÃO usamos scrypt: precisamos de busca por igualdade (achar se um CPF
 * já existe), o que exige determinismo. Usamos HMAC-SHA256 com a chave do
 * servidor — um vazamento do banco sozinho não permite testar CPFs, porque
 * o espaço é pequeno o bastante para força bruta sem a chave.
 */
export function blindIndex(secret, value) {
  if (!secret) throw new Error('blindIndex exige o segredo do servidor.');
  return createHmac('sha256', secret).update(String(value), 'utf8').digest('hex');
}
