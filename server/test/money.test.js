/* Testes do razao e das regras do jogo.
 * Rode com: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Banco temporario por execucao, para nao encostar nos dados reais.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-test-'));

const { db } = await import('../src/db.js');
const {
  postTransaction, balanceOf, userAccount, escrowAccount,
  splitPot, auditIntegrity, HOUSE_RAKE, EXTERNAL_PSP,
} = await import('../src/money.js');
const Ludo = await import('../src/ludo.js');
const Match = await import('../src/match.js');

const now = Date.now();
const mkUser = (id) => db.prepare(
  `INSERT INTO users (id,email,name,pass_hash,pass_salt,created_at,updated_at)
   VALUES (?,?,?,'x','y',?,?)`).run(id, `${id}@t.com`, id, now, now);

const fund = (id, cents) => postTransaction({
  kind: 'deposit', idempotencyKey: `seed:${id}:${cents}:${Math.random()}`,
  entries: [
    { account: EXTERNAL_PSP, amount_cents: -cents },
    { account: userAccount(id), amount_cents: +cents },
  ],
});

/* ----------------------------------------------------------- razao */

test('pernas que nao somam zero sao recusadas', () => {
  assert.throws(() => postTransaction({
    kind: 'adjustment',
    entries: [
      { account: 'user:x', amount_cents: 100 },
      { account: 'house:rake', amount_cents: -50 },
    ],
  }), /nao somam zero/);
});

test('saldo de jogador nunca fica negativo', () => {
  mkUser('pobre');
  fund('pobre', 1000);
  assert.throws(() => postTransaction({
    kind: 'stake',
    entries: [
      { account: userAccount('pobre'), amount_cents: -5000 },
      { account: escrowAccount('XXXXXX'), amount_cents: +5000 },
    ],
  }), (e) => e.code === 'INSUFFICIENT_FUNDS');
  // O rollback precisa ter desfeito TUDO, inclusive a perna do escrow.
  assert.equal(balanceOf(userAccount('pobre')), 1000);
  assert.equal(balanceOf(escrowAccount('XXXXXX')), 0);
});

test('a mesma chave de idempotencia nao credita duas vezes', () => {
  mkUser('dup');
  const key = 'deposito-unico-123';
  for (let i = 0; i < 5; i++) {
    postTransaction({
      kind: 'deposit', idempotencyKey: key,
      entries: [
        { account: EXTERNAL_PSP, amount_cents: -2500 },
        { account: userAccount('dup'), amount_cents: +2500 },
      ],
    });
  }
  assert.equal(balanceOf(userAccount('dup')), 2500, 'cinco tentativas, um credito so');
});

test('o razao e imutavel', () => {
  mkUser('imut'); fund('imut', 500);
  const row = db.prepare('SELECT id FROM ledger_entry ORDER BY id DESC LIMIT 1').get();
  assert.throws(() => db.prepare('UPDATE ledger_entry SET amount_cents=999 WHERE id=?').run(row.id), /imutavel/);
  assert.throws(() => db.prepare('DELETE FROM ledger_entry WHERE id=?').run(row.id), /imutavel/);
});

test('divisao do pote fecha em inteiros, sem centavo orfao', () => {
  for (const pot of [200, 333, 1, 99999, 12345, 7]) {
    const { winnerCents, rakeCents } = splitPot(pot, 2000);
    assert.equal(winnerCents + rakeCents, pot, `pote ${pot} nao fechou`);
    assert.ok(Number.isSafeInteger(winnerCents) && Number.isSafeInteger(rakeCents));
  }
  // O caso que o codigo antigo errava: 0.1*2*0.8 em float da 0.16000000000000003
  assert.deepEqual(splitPot(20, 2000), { winnerCents: 16, rakeCents: 4 });
});

/* ------------------------------------------------- ciclo do desafio */

test('ciclo completo: apostar, jogar, pagar — e o escrow zera', () => {
  mkUser('ana'); mkUser('bia');
  fund('ana', 10000); fund('bia', 10000);

  const ch = Match.createChallenge({ userId: 'ana', stakeCents: 2500 });
  assert.equal(balanceOf(userAccount('ana')), 7500, 'aposta saiu da carteira');
  assert.equal(balanceOf(escrowAccount(ch.code)), 2500, 'e entrou no escrow');

  Match.acceptChallenge({ code: ch.code, userId: 'bia' });
  assert.equal(balanceOf(escrowAccount(ch.code)), 5000, 'pote completo');

  // Forca o fim de jogo com a vermelha (ana) vencendo.
  const m = Match.loadMatch(ch.code);
  const st = m.state;
  st.players[0].tokens = [56, 56, 56, 55];
  st.curIdx = 0; st.dice = 1;
  db.prepare('UPDATE matches SET state_json=? WHERE code=?').run(JSON.stringify(st), ch.code);

  Match.makeMove({ code: ch.code, userId: 'ana', tokenIdx: 3 });

  const fin = db.prepare('SELECT * FROM challenges WHERE code=?').get(ch.code);
  assert.equal(fin.status, 'resolved');
  assert.equal(fin.winner_id, 'ana');
  assert.equal(balanceOf(escrowAccount(ch.code)), 0, 'escrow tem de esvaziar');
  assert.equal(balanceOf(userAccount('ana')), 7500 + 4000, '80% de 5000');
  assert.equal(balanceOf(HOUSE_RAKE), 1000, '20% de comissao');
  assert.equal(balanceOf(userAccount('bia')), 7500, 'perdedor nao recebe nada');
});

test('aposta sem saldo nao cria desafio orfao', () => {
  mkUser('duro'); fund('duro', 100);
  assert.throws(() => Match.createChallenge({ userId: 'duro', stakeCents: 5000 }),
    (e) => e.code === 'INSUFFICIENT_FUNDS');
  const left = db.prepare(`SELECT COUNT(*) c FROM challenges WHERE creator_id='duro'`).get().c;
  assert.equal(left, 0, 'rollback tem de levar o desafio junto');
});

test('cancelar devolve a aposta', () => {
  mkUser('cancel'); fund('cancel', 5000);
  const ch = Match.createChallenge({ userId: 'cancel', stakeCents: 2000 });
  assert.equal(balanceOf(userAccount('cancel')), 3000);
  Match.cancelChallenge({ code: ch.code, userId: 'cancel' });
  assert.equal(balanceOf(userAccount('cancel')), 5000, 'devolvido integralmente');
  assert.equal(balanceOf(escrowAccount(ch.code)), 0);
});

test('nao da para jogar fora da sua vez nem em partida alheia', () => {
  mkUser('p1'); mkUser('p2'); mkUser('xereta');
  fund('p1', 5000); fund('p2', 5000);
  const ch = Match.createChallenge({ userId: 'p1', stakeCents: 1000 });
  Match.acceptChallenge({ code: ch.code, userId: 'p2' });

  // Comeca com a vermelha (p1); p2 tentando rolar tem de falhar.
  assert.throws(() => Match.rollDice({ code: ch.code, userId: 'p2' }),
    (e) => e.code === 'NOT_YOUR_TURN');
  assert.throws(() => Match.rollDice({ code: ch.code, userId: 'xereta' }),
    (e) => e.code === 'FORBIDDEN');
});

test('trava otimista impede rolagem dupla', () => {
  mkUser('t1'); mkUser('t2'); fund('t1', 5000); fund('t2', 5000);
  const ch = Match.createChallenge({ userId: 't1', stakeCents: 1000 });
  Match.acceptChallenge({ code: ch.code, userId: 't2' });

  const v = Match.loadMatch(ch.code).version;
  Match.rollDice({ code: ch.code, userId: 't1', version: v });

  /* O reenvio carrega a MESMA versao de antes. Precisa dar STALE, e precisa dar
     STALE mesmo quando a primeira rolagem ja passou a vez (dado sem jogada
     possivel) — por isso a checagem de versao vem antes da checagem de vez. */
  assert.throws(() => Match.rollDice({ code: ch.code, userId: 't1', version: v }),
    (e) => e.code === 'STALE');

  // E o reenvio nao pode ter gerado uma segunda rolagem no historico.
  const rolls = db.prepare('SELECT COUNT(*) c FROM dice_rolls WHERE code=?').get(ch.code).c;
  assert.equal(rolls, 1, 'uma rolagem registrada, nao duas');
});

/* --------------------------------------------------------- o dado */

test('o dado do servidor e uniforme e deterministico pela semente', () => {
  const seed = 'a'.repeat(64);
  assert.equal(Match.rollDie(seed, 'ABC123', 7), Match.rollDie(seed, 'ABC123', 7),
    'mesma semente e nonce tem de dar o mesmo valor — e isso que permite auditar');

  const counts = [0, 0, 0, 0, 0, 0, 0];
  const N = 60000;
  for (let i = 1; i <= N; i++) counts[Match.rollDie(seed, 'ABC123', i)]++;
  for (let v = 1; v <= 6; v++) {
    const share = counts[v] / N;
    assert.ok(Math.abs(share - 1 / 6) < 0.01, `face ${v} saiu ${(share * 100).toFixed(2)}%`);
  }
});

/* ----------------------------------------------------- regras do ludo */

test('peca precisa do numero exato para entrar em casa', () => {
  const s = Ludo.newGame(['red', 'blue']);
  s.players[0].tokens = [54, -1, -1, -1];
  assert.deepEqual(Ludo.legalMoves(s, s.players[0], 2), [0], 'com 2 chega exatamente em 56');
  assert.deepEqual(Ludo.legalMoves(s, s.players[0], 4), [], 'com 4 passaria de 56');
});

test('so sai do curral tirando 6', () => {
  const s = Ludo.newGame(['red', 'blue']);
  assert.deepEqual(Ludo.legalMoves(s, s.players[0], 5), []);
  assert.deepEqual(Ludo.legalMoves(s, s.players[0], 6), [0, 1, 2, 3]);
});

test('captura manda a peca adversaria para o curral', () => {
  const s = Ludo.newGame(['red', 'blue']);
  // blue entra em 39; a posicao 3 da blue e o indice fisico 42.
  // Para a red, o indice fisico 42 corresponde a posicao 42.
  s.players[0].tokens = [40, -1, -1, -1];
  s.players[1].tokens = [3, -1, -1, -1];
  assert.equal(Ludo.physIndex('blue', 3), 42);
  s.dice = 2;
  const { state, captured } = Ludo.applyMove(s, 0);
  assert.ok(captured, 'deveria capturar');
  assert.equal(state.players[1].tokens[0], -1, 'voltou para o curral');
});

test('casa segura protege de captura', () => {
  const s = Ludo.newGame(['red', 'blue']);
  // Indice fisico 47 e estrela (casa segura).
  s.players[1].tokens = [8, -1, -1, -1];
  assert.equal(Ludo.physIndex('blue', 8), 47);
  assert.ok(Ludo.SAFE_IDX.has(47));
  s.players[0].tokens = [45, -1, -1, -1];
  s.dice = 2;
  const { state, captured } = Ludo.applyMove(s, 0);
  assert.equal(captured, false, 'nao pode capturar em casa segura');
  assert.equal(state.players[1].tokens[0], 8, 'a peca continua la');
});

test('duas pecas inimigas formam bloqueio', () => {
  const s = Ludo.newGame(['red', 'blue']);
  s.players[1].tokens = [4, 4, -1, -1];           // fisico 43, nao e casa segura
  s.players[0].tokens = [41, -1, -1, -1];         // fisico 41
  assert.equal(Ludo.physIndex('blue', 4), 43);
  assert.deepEqual(Ludo.legalMoves(s, s.players[0], 2), [], 'bloqueio impede pousar');
});

test('jogada ilegal vinda do cliente e recusada', () => {
  const s = Ludo.newGame(['red', 'blue']);
  s.dice = 3;    // sem 6, nada sai do curral
  assert.throws(() => Ludo.applyMove(s, 0), (e) => e.code === 'ILLEGAL_MOVE');
});

test('seis da direito a jogar de novo', () => {
  const s = Ludo.newGame(['red', 'blue']);
  s.players[0].tokens = [10, -1, -1, -1];
  s.dice = 6;
  const { state, extraTurn } = Ludo.applyMove(s, 0);
  assert.ok(extraTurn);
  assert.equal(state.curIdx, 0, 'continua com o mesmo jogador');
});

/* ------------------------------------------------------- integridade */

test('no fim de tudo, o razao esta integro', () => {
  const r = auditIntegrity();
  assert.deepEqual(r.unbalanced, [], 'nenhuma transacao desbalanceada');
  assert.deepEqual(r.drifted, [], 'cache de saldo bate com o razao');
  assert.equal(r.grandTotal, 0, 'partida dobrada: a soma de tudo e zero');
  assert.ok(r.ok);
});
