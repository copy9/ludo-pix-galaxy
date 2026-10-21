import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateServerSeed,
  generateClientSeed,
  commitFor,
  verifyCommit,
  rollFromSeeds,
  replayRolls,
  challengeCode,
  DIE_FACES,
} from '../src/lib/rng.js';

test('o commit confere com o seed revelado e rejeita qualquer outro', () => {
  const seed = generateServerSeed();
  const commit = commitFor(seed);
  assert.equal(verifyCommit(seed, commit), true);
  assert.equal(verifyCommit(generateServerSeed(), commit), false);
  assert.equal(verifyCommit(seed, 'ff'.repeat(32)), false);
  assert.equal(verifyCommit(seed, 'tamanho-errado'), false);
});

test('o mesmo conjunto de seeds sempre produz o mesmo lance', () => {
  const args = { serverSeed: 'a'.repeat(64), clientSeed: 'cliente', matchId: 'M1', nonce: 7 };
  assert.equal(rollFromSeeds(args), rollFromSeeds(args));
});

test('mudar qualquer seed muda a sequência', () => {
  const base = { serverSeed: 'a'.repeat(64), clientSeed: 'cliente', matchId: 'M1', count: 40 };
  const a = replayRolls(base);
  const b = replayRolls({ ...base, clientSeed: 'outro' });
  assert.notDeepEqual(a, b, 'o seed do cliente precisa influenciar o resultado');
});

test('todo lance cai entre 1 e 6', () => {
  const rolls = replayRolls({
    serverSeed: generateServerSeed(),
    clientSeed: generateClientSeed(),
    matchId: 'M1',
    count: 5000,
  });
  for (const r of rolls) {
    assert.ok(Number.isInteger(r) && r >= 1 && r <= DIE_FACES, `lance fora da faixa: ${r}`);
  }
});

test('a distribuição é uniforme — nenhuma face é favorecida', () => {
  const N = 120000;
  const counts = new Array(7).fill(0);
  const serverSeed = generateServerSeed();
  for (const r of replayRolls({ serverSeed, clientSeed: 'c', matchId: 'M', count: N })) {
    counts[r] += 1;
  }
  const expected = N / DIE_FACES;
  // Qui-quadrado com 5 graus de liberdade: 20,5 é bem acima do crítico de
  // 15,09 (p=0,01), então uma falha aqui indica viés real, não azar.
  const chi2 = counts.slice(1).reduce((s, o) => s + ((o - expected) ** 2) / expected, 0);
  assert.ok(chi2 < 20.5, `qui-quadrado alto demais: ${chi2.toFixed(2)} — dado enviesado`);
});

test('não existe sequência de seis fácil como no protótipo', () => {
  // O SIX_TEST_MODE antigo devolvia o número "útil" em 90% das vezes.
  // Aqui nenhuma face deve passar de ~20% em uma amostra grande.
  const counts = new Array(7).fill(0);
  for (const r of replayRolls({ serverSeed: generateServerSeed(), clientSeed: 'c', matchId: 'M', count: 20000 })) {
    counts[r] += 1;
  }
  const maxShare = Math.max(...counts.slice(1)) / 20000;
  assert.ok(maxShare < 0.2, `face dominante em ${(maxShare * 100).toFixed(1)}% dos lances`);
});

test('o código de desafio tem o tamanho pedido e evita caracteres ambíguos', () => {
  for (let i = 0; i < 500; i += 1) {
    const code = challengeCode(6);
    assert.equal(code.length, 6);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  }
});

test('os códigos de desafio não se repetem com facilidade', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(challengeCode(6));
  assert.ok(seen.size > 4990, `colisões demais: ${5000 - seen.size}`);
});
