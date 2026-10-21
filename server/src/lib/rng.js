/**
 * Sorteio do dado — justo e auditável (commit–reveal).
 *
 * O problema: se o servidor sorteia o dado em segredo, o jogador precisa
 * confiar cegamente que não houve viés. Se o cliente sorteia, é pior ainda.
 * A solução padrão da indústria ("provably fair"):
 *
 *   1. Ao abrir a partida, o servidor gera um `serverSeed` aleatório e publica
 *      apenas o SHA-256 dele (o "commit"). O seed fica escondido.
 *   2. Cada jogador envia um `clientSeed`. Ninguém controla o resultado
 *      sozinho: o servidor não sabe os seeds dos clientes quando escolhe o
 *      seu, e os clientes não sabem o do servidor.
 *   3. Cada lance é HMAC-SHA256(serverSeed, `${matchId}:${nonce}`), reduzido a
 *      1..6 por rejeição de amostras (sem o viés do operador `%`).
 *   4. Ao fim da partida o servidor revela o `serverSeed`. Qualquer pessoa
 *      recalcula todos os lances e confere que batem com o commit publicado
 *      ANTES da partida começar — o servidor não poderia ter mudado o seed
 *      depois de ver as jogadas.
 *
 * O `SIX_TEST_MODE` do protótipo (dado viciado em 90%) não existe aqui e não
 * deve existir: não há caminho de código que escolha o resultado do dado.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DIE_FACES = 6;

/** Gera o seed secreto do servidor para uma partida. */
export function generateServerSeed() {
  return randomBytes(32).toString('hex');
}

/** Gera um seed de cliente padrão, caso o jogador não envie o seu. */
export function generateClientSeed() {
  return randomBytes(16).toString('hex');
}

/** O compromisso publicado antes da partida. */
export function commitFor(serverSeed) {
  return createHash('sha256').update(serverSeed, 'utf8').digest('hex');
}

/** Confere que um seed revelado corresponde ao commit publicado. */
export function verifyCommit(serverSeed, commit) {
  const expected = Buffer.from(commitFor(serverSeed), 'hex');
  let given;
  try {
    given = Buffer.from(commit, 'hex');
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * Converte o fluxo HMAC em um número de 1 a 6 sem viés.
 *
 * 256 não é divisível por 6, então `byte % 6` favoreceria as faces 1..4.
 * Descartamos os bytes >= 252 (o maior múltiplo de 6 abaixo de 256) e seguimos
 * para o próximo byte. A chance de precisar de outro byte é 4/256.
 */
export function rollFromSeeds({ serverSeed, clientSeed, matchId, nonce }) {
  const message = `${clientSeed}:${matchId}:${nonce}`;
  let round = 0;
  // Praticamente sempre resolve na primeira rodada; o laço é a garantia formal.
  while (round < 64) {
    const digest = createHmac('sha256', serverSeed)
      .update(round === 0 ? message : `${message}:${round}`, 'utf8')
      .digest();
    const limit = 256 - (256 % DIE_FACES); // 252
    for (const byte of digest) {
      if (byte < limit) return (byte % DIE_FACES) + 1;
    }
    round += 1;
  }
  /* c8 ignore next */
  throw new Error('Falha ao sortear o dado: entropia esgotada.');
}

/**
 * Recalcula todos os lances de uma partida a partir do seed revelado.
 * É o que a página de verificação do jogador usa.
 */
export function replayRolls({ serverSeed, clientSeed, matchId, count }) {
  const rolls = [];
  for (let nonce = 0; nonce < count; nonce += 1) {
    rolls.push(rollFromSeeds({ serverSeed, clientSeed, matchId, nonce }));
  }
  return rolls;
}

/** Token opaco para sessões, idempotência e códigos de desafio. */
export function secureToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Código curto de desafio, legível em voz alta.
 * Sem 0/O/1/I/L para não gerar confusão, e com randomBytes em vez de
 * Math.random — o protótipo usava Math.random, que é previsível.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function challengeCode(length = 6) {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i += 1) {
    // Rejeição de amostras também aqui, para não enviesar o alfabeto.
    const limit = 256 - (256 % CODE_ALPHABET.length);
    if (bytes[i] < limit) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out.length === length ? out : challengeCode(length);
}
