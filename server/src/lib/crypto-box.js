/**
 * Cifra simétrica para dados sensíveis que precisam VOLTAR ao claro.
 *
 * Nem todo dado sensível pode virar hash. A chave Pix do jogador é o exemplo:
 * para enviar o saque, o servidor precisa da chave real — hash não desfaz.
 *
 * Então a regra é por finalidade:
 *   • senha            → scrypt (nunca volta ao claro)
 *   • CPF, busca       → blindIndex, HMAC determinístico (comparação por igualdade)
 *   • chave Pix        → AQUI: AES-256-GCM, volta ao claro só no momento do pagamento
 *
 * AES-GCM é autenticado: se alguém adulterar o texto cifrado no banco, a
 * decifragem falha em vez de devolver lixo silenciosamente.
 *
 * A chave de cifra NÃO é o SESSION_SECRET: é derivada dele por HKDF com um
 * rótulo próprio, para que o mesmo segredo mestre sirva a usos distintos sem
 * que o vazamento de um comprometa o outro.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // tamanho recomendado para GCM
const TAG_BYTES = 16;
const VERSION = 'v1';  // permite trocar de algoritmo no futuro sem quebrar o que já está gravado

const keyCache = new Map();

function deriveKey(masterSecret, purpose) {
  const cacheKey = `${purpose}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  if (!masterSecret || masterSecret.length < 32) {
    throw new Error('Segredo mestre ausente ou curto demais para derivar chave de cifra.');
  }
  const derived = Buffer.from(
    hkdfSync('sha256', Buffer.from(masterSecret, 'utf8'), Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32),
  );
  keyCache.set(cacheKey, derived);
  return derived;
}

/**
 * Cifra um texto. Devolve `v1.<iv>.<tag>.<texto cifrado>` em base64url.
 *
 * `aad` (dados autenticados adicionais) amarra o texto cifrado ao contexto:
 * passando o id do usuário, um texto cifrado copiado da linha de outro
 * jogador não decifra. Fecha o ataque de "trocar a chave Pix do vizinho pela
 * minha no banco".
 */
export function seal(masterSecret, plaintext, { purpose = 'generic', aad } = {}) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Nada para cifrar.');
  }
  const key = deriveKey(masterSecret, purpose);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

/** Decifra. Lança se o texto tiver sido adulterado ou o contexto não bater. */
export function open(masterSecret, sealed, { purpose = 'generic', aad } = {}) {
  if (typeof sealed !== 'string') throw new Error('Texto cifrado inválido.');
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Formato de texto cifrado desconhecido.');

  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Texto cifrado malformado.');

  const key = deriveKey(masterSecret, purpose);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  // `final()` lança se a autenticação falhar — é exatamente o que queremos.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Limpa o cache de chaves derivadas. Usado nos testes. */
export function __resetKeyCache() {
  keyCache.clear();
}
