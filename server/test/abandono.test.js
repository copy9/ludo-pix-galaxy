/* Partida abandonada.
 *
 * Achado da auditoria independente: depois que os dois apostavam, o unico
 * caminho que esvaziava o escrow era a partida TERMINAR. Quem fechava o
 * navegador no meio deixava as duas apostas presas para sempre — e quem estava
 * perdendo ganhava um motivo para sumir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-aband-'));
process.env.NODE_ENV = 'test';
process.env.MATCH_IDLE_MS = '600000';   // 10 min

const { db } = await import('../src/db.js');
const M = await import('../src/money.js');
const Match = await import('../src/match.js');

const now = Date.now();
let n = 0;
function par(saldo = 100000) {
  const a = 'ab' + (++n), b = 'ab' + (++n);
  for (const id of [a, b]) {
    db.prepare(`INSERT INTO users (id,email,name,pass_hash,pass_salt,created_at,updated_at)
                VALUES (?,?,?,'x','y',?,?)`).run(id, id + '@a.com', id, now, now);
    M.postTransaction({
      kind: 'deposit', idempotencyKey: 'ab-' + id,
      entries: [
        { account: M.EXTERNAL_PSP, amount_cents: -saldo },
        { account: M.userAccount(id), amount_cents: +saldo },
      ],
    });
  }
  return [a, b];
}
const envelhecer = (code, ms) =>
  db.prepare('UPDATE matches SET updated_at=? WHERE code=?').run(Date.now() - ms, code);

test('abandono ANTES de qualquer jogada devolve a aposta aos dois', () => {
  const [a, b] = par();
  const ch = Match.createChallenge({ userId: a, stakeCents: 5000 });
  Match.acceptChallenge({ code: ch.code, userId: b });
  assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 10000);

  envelhecer(ch.code, 20 * 60 * 1000);
  assert.equal(Match.forfeitIdle(), 1);

  assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 0, 'escrow tem de esvaziar');
  assert.equal(M.balanceOf(M.userAccount(a)), 100000, 'criador reembolsado');
  assert.equal(M.balanceOf(M.userAccount(b)), 100000, 'adversario reembolsado');
  // Partida que nao aconteceu nao gera comissao.
  assert.equal(M.balanceOf(M.HOUSE_RAKE), 0, 'sem rake em partida que nao comecou');
  assert.equal(db.prepare('SELECT status FROM challenges WHERE code=?').get(ch.code).status, 'cancelled');
  assert.ok(M.auditIntegrity().ok);
});

test('abandono DEPOIS de comecar: quem tinha a vez perde por W.O.', () => {
  const [a, b] = par();
  const rakeAntes = M.balanceOf(M.HOUSE_RAKE);
  const ch = Match.createChallenge({ userId: a, stakeCents: 5000 });
  Match.acceptChallenge({ code: ch.code, userId: b });

  // 'a' (red) joga, depois sai. A vez volta para ele em algum momento;
  // rolamos ate que seja a vez de red e paramos ali.
  let st = Match.publicState(db.prepare('SELECT * FROM challenges WHERE code=?').get(ch.code),
    Match.loadMatch(ch.code), a);
  const cor = { red: a, blue: b };
  let guard = 0;
  while (st.game.players[st.game.curIdx].color !== 'red' || st.game.dice == null) {
    if (guard++ > 200) break;
    const quem = cor[st.game.players[st.game.curIdx].color];
    st = st.game.dice == null
      ? Match.rollDice({ code: ch.code, userId: quem }).state
      : Match.makeMove({ code: ch.code, userId: quem, tokenIdx: st.legalMoves[0] }).state;
    if (st.game.gameOver) return;   // terminou sozinho; nada a testar aqui
  }
  assert.equal(st.game.players[st.game.curIdx].color, 'red', 'e a vez de red');

  envelhecer(ch.code, 20 * 60 * 1000);
  assert.equal(Match.forfeitIdle(), 1);

  const fim = db.prepare('SELECT * FROM challenges WHERE code=?').get(ch.code);
  assert.equal(fim.status, 'resolved');
  assert.equal(fim.winner_id, b, 'quem ficou leva');
  assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 0, 'escrow esvaziado');
  assert.equal(M.balanceOf(M.userAccount(b)), 95000 + 8000, '80% do pote de 10000');
  assert.equal(M.balanceOf(M.HOUSE_RAKE) - rakeAntes, 2000, 'comissao cobrada');
  // Abandonar custou a aposta: e isso que tira o incentivo de sumir perdendo.
  assert.equal(M.balanceOf(M.userAccount(a)), 95000);
  assert.ok(M.auditIntegrity().ok);
});

test('o estado da partida tambem e marcado como encerrado', () => {
  const [a, b] = par();
  const ch = Match.createChallenge({ userId: a, stakeCents: 2000 });
  Match.acceptChallenge({ code: ch.code, userId: b });
  Match.rollDice({ code: ch.code, userId: a });

  envelhecer(ch.code, 20 * 60 * 1000);
  Match.forfeitIdle();

  const st = Match.loadMatch(ch.code).state;
  assert.equal(st.gameOver, true, 'quem reabrir a pagina precisa ver que acabou');
  assert.ok(st.winnerColor);
});

test('partida ativa NAO e encerrada por engano', () => {
  const [a, b] = par();
  const ch = Match.createChallenge({ userId: a, stakeCents: 3000 });
  Match.acceptChallenge({ code: ch.code, userId: b });
  Match.rollDice({ code: ch.code, userId: a });

  envelhecer(ch.code, 60 * 1000);          // so 1 minuto parada
  assert.equal(Match.forfeitIdle(), 0, 'nao pode encerrar partida recente');
  assert.equal(db.prepare('SELECT status FROM challenges WHERE code=?').get(ch.code).status, 'both_staked');
  assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 6000, 'aposta segue no escrow');
});

test('desistencia voluntaria paga o adversario na hora', () => {
  const [a, b] = par();
  const rakeAntes = M.balanceOf(M.HOUSE_RAKE);
  const ch = Match.createChallenge({ userId: a, stakeCents: 5000 });
  Match.acceptChallenge({ code: ch.code, userId: b });

  Match.forfeit({ code: ch.code, userId: a });

  assert.equal(db.prepare('SELECT winner_id FROM challenges WHERE code=?').get(ch.code).winner_id, b);
  assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 0);
  assert.equal(M.balanceOf(M.userAccount(b)), 95000 + 8000);
  assert.equal(M.balanceOf(M.HOUSE_RAKE) - rakeAntes, 2000);
  assert.ok(M.auditIntegrity().ok);
});

test('estranho nao pode desistir pela partida dos outros', () => {
  const [a, b] = par();
  const [x] = par();
  const ch = Match.createChallenge({ userId: a, stakeCents: 1000 });
  Match.acceptChallenge({ code: ch.code, userId: b });
  assert.throws(() => Match.forfeit({ code: ch.code, userId: x }), (e) => e.code === 'FORBIDDEN');
  assert.equal(M.balanceOf(M.escrowAccount(ch.code)), 2000, 'nada mudou');
});

test('rodar a faxina duas vezes nao paga em dobro', () => {
  const [a, b] = par();
  const ch = Match.createChallenge({ userId: a, stakeCents: 4000 });
  Match.acceptChallenge({ code: ch.code, userId: b });
  Match.rollDice({ code: ch.code, userId: a });

  envelhecer(ch.code, 20 * 60 * 1000);
  Match.forfeitIdle();
  const depois = ['user:' + a, 'user:' + b, M.HOUSE_RAKE].map((c) => M.balanceOf(c));

  Match.forfeitIdle();
  Match.forfeitIdle();
  assert.deepEqual(['user:' + a, 'user:' + b, M.HOUSE_RAKE].map((c) => M.balanceOf(c)), depois);
  assert.ok(M.auditIntegrity().ok);
});

test('escrow de partida encerrada sempre zera', () => {
  /* Partida ainda em andamento DEVE ter saldo no escrow — e dinheiro
     legitimamente preso enquanto o jogo acontece. O que nao pode existir e
     escrow com saldo numa partida ja encerrada. */
  const travados = db.prepare(`
    SELECT b.account, b.balance_cents, c.status
    FROM balances b
    JOIN challenges c ON ('escrow:' || c.code) = b.account
    WHERE b.balance_cents != 0
      AND c.status IN ('resolved','cancelled','expired')`).all();
  assert.deepEqual(travados, [], 'escrow de partida encerrada nao pode ter saldo');

  const emAndamento = db.prepare(`
    SELECT COUNT(*) n FROM challenges WHERE status='both_staked'`).get().n;
  assert.ok(emAndamento > 0, 'o teste so vale se houver partida ativa para contrastar');
  assert.ok(M.auditIntegrity().ok);
});
