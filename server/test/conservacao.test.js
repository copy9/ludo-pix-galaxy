/* Conservacao de dinheiro sob jogo aleatorio.
 *
 * Testes de caso isolado provam que cada operacao funciona. Este prova a
 * propriedade que de fato importa: depois de muitas partidas aleatorias, com
 * cancelamentos e apostas sem saldo pelo meio, a soma de tudo continua igual
 * ao que foi depositado. Nenhum centavo criado, nenhum perdido.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-cons-'));
process.env.NODE_ENV = 'test';

const { db } = await import('../src/db.js');
const M = await import('../src/money.js');
const Match = await import('../src/match.js');

test('dinheiro se conserva em muitas partidas aleatorias', () => {
  const N_JOG = 8, N_PARTIDAS = 60, DEPOSITO = 100000;
  const ids = Array.from({ length: N_JOG }, (_, i) => 'c' + i);
  const now = Date.now();

  for (const id of ids) {
    db.prepare(`INSERT INTO users (id,email,name,pass_hash,pass_salt,created_at,updated_at)
                VALUES (?,?,?,'x','y',?,?)`).run(id, id + '@c.com', id, now, now);
    M.postTransaction({
      kind: 'deposit', idempotencyKey: 'cons-' + id,
      entries: [
        { account: M.EXTERNAL_PSP, amount_cents: -DEPOSITO },
        { account: M.userAccount(id), amount_cents: +DEPOSITO },
      ],
    });
  }
  const TOTAL = N_JOG * DEPOSITO;
  const rnd = (n) => Math.floor(Math.random() * n);

  for (let k = 0; k < N_PARTIDAS; k++) {
    const a = ids[rnd(N_JOG)];
    let b = ids[rnd(N_JOG)];
    while (b === a) b = ids[rnd(N_JOG)];
    const stake = (1 + rnd(200)) * 100;

    let ch;
    try { ch = Match.createChallenge({ userId: a, stakeCents: stake }); }
    catch { continue; }                       // sem saldo: segue o baile

    if (Math.random() < 0.15) {                // parte dos desafios e cancelada
      Match.cancelChallenge({ code: ch.code, userId: a });
      assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 0, 'cancelar tem de esvaziar o escrow');
      continue;
    }
    try { Match.acceptChallenge({ code: ch.code, userId: b }); }
    catch { Match.cancelChallenge({ code: ch.code, userId: a }); continue; }

    const cor = { red: a, blue: b };
    let st = Match.publicState(
      db.prepare('SELECT * FROM challenges WHERE code=?').get(ch.code),
      Match.loadMatch(ch.code), a);

    let guard = 0;
    while (!st.game.gameOver && guard++ < 5000) {
      const quem = cor[st.game.players[st.game.curIdx].color];
      st = st.game.dice == null
        ? Match.rollDice({ code: ch.code, userId: quem }).state
        : Match.makeMove({ code: ch.code, userId: quem, tokenIdx: st.legalMoves[rnd(st.legalMoves.length)] }).state;
    }
    assert.ok(st.game.gameOver, 'a partida precisa terminar');
    assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 0, `escrow de ${ch.code} nao esvaziou`);
  }

  const jogadores = ids.reduce((s, id) => s + M.balanceOf(M.userAccount(id)), 0);
  const rake = M.balanceOf(M.HOUSE_RAKE);
  const preso = db.prepare(
    `SELECT COALESCE(SUM(balance_cents),0) t FROM balances WHERE account LIKE 'escrow:%'`).get().t;

  assert.equal(jogadores + rake + preso, TOTAL,
    'a soma de jogadores + comissao + escrow tem de bater com o depositado');

  const negativos = db.prepare(
    `SELECT account FROM balances WHERE account LIKE 'user:%' AND balance_cents < 0`).all();
  assert.deepEqual(negativos, [], 'nenhum saldo de jogador pode ficar negativo');

  const integridade = M.auditIntegrity();
  assert.ok(integridade.ok, JSON.stringify(integridade));
});
