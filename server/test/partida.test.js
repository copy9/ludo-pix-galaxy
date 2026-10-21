/* Partida inteira, do deposito ao pagamento, pela API — como dois navegadores fariam.
 * Este e o teste que prova que o ciclo do dinheiro fecha de ponta a ponta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-match-'));
process.env.PSP_WEBHOOK_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const server = (await import('../src/index.js')).default;
const { db } = await import('../src/db.js');
const { balanceOf, userAccount, escrowAccount, auditIntegrity, HOUSE_RAKE } = await import('../src/money.js');

await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const sends = method !== 'GET' && body !== undefined;
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(sends ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: BASE },
      body: sends ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    const t = await res.text();
    return { status: res.status, body: t ? JSON.parse(t) : null };
  };
}

async function setup(c, email, cents, ev) {
  await c('POST', '/api/auth/register', { email, name: email.split('@')[0], password: 'senha-forte-123' });
  const dep = await c('POST', '/api/wallet/deposit', { amountCents: cents });
  const payload = JSON.stringify({ id: ev, type: 'payment.paid', data: { id: dep.body.ref, amount: cents, status: 'paid' } });
  const sig = createHmac('sha256', process.env.PSP_WEBHOOK_SECRET).update(payload).digest('hex');
  await fetch(BASE + '/api/webhooks/psp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: payload,
  });
  return (await c('GET', '/api/me')).body;
}

test('partida completa entre dois jogadores, ate o pagamento', async () => {
  const a = client(), b = client();
  const ua = await setup(a, 'alice@t.com', 20000, 'ev-alice');
  const ub = await setup(b, 'bob@t.com', 20000, 'ev-bob');
  assert.equal(ua.balanceCents, 20000);
  assert.equal(ub.balanceCents, 20000);

  const STAKE = 5000;
  const ch = (await a('POST', '/api/challenges', { stakeCents: STAKE })).body;
  await b('POST', `/api/challenges/${ch.code}/accept`);

  assert.equal(balanceOf(escrowAccount(ch.code)), STAKE * 2, 'pote preso no escrow');
  assert.equal((await a('GET', '/api/me')).body.balanceCents, 15000);
  assert.equal((await b('GET', '/api/me')).body.balanceCents, 15000);

  /* Joga de verdade, alternando conforme o servidor manda, ate alguem vencer.
     Nenhum dos dois decide nada: so pede roll/move e obedece ao estado. */
  const players = { red: a, blue: b };
  let guard = 0;
  let st = (await a('GET', `/api/challenges/${ch.code}`)).body;

  while (!st.game.gameOver && guard++ < 4000) {
    const color = st.game.players[st.game.curIdx].color;
    const who = players[color];

    if (st.game.dice == null) {
      const r = await who('POST', `/api/challenges/${ch.code}/roll`, { version: st.version });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      st = r.body.state;
    } else {
      assert.ok(st.legalMoves.length > 0, 'com dado posto tem de haver jogada');
      const mv = await who('POST', `/api/challenges/${ch.code}/move`,
        { tokenIdx: st.legalMoves[0], version: st.version });
      assert.equal(mv.status, 200, JSON.stringify(mv.body));
      st = mv.body.state;
    }
  }

  assert.ok(st.game.gameOver, `a partida precisa terminar (${guard} passos)`);
  const winner = st.game.winnerColor;
  assert.ok(winner === 'red' || winner === 'blue');

  // O escrow esvaziou e o dinheiro foi para os lugares certos.
  assert.equal(balanceOf(escrowAccount(ch.code)), 0, 'escrow tem de zerar');
  const pot = STAKE * 2;
  const rake = Math.floor(pot * 2000 / 10000);
  const winnerBal = (await (winner === 'red' ? a : b)('GET', '/api/me')).body.balanceCents;
  const loserBal  = (await (winner === 'red' ? b : a)('GET', '/api/me')).body.balanceCents;

  assert.equal(winnerBal, 15000 + (pot - rake), 'vencedor recebeu 80% do pote');
  assert.equal(loserBal, 15000, 'perdedor nao recebeu nada');
  assert.equal(balanceOf(HOUSE_RAKE), rake, 'comissao da casa');

  // Nada se perdeu: o que saiu das carteiras voltou inteiro.
  assert.equal(winnerBal + loserBal + rake, 40000, 'soma final bate com os depositos');

  const audit = auditIntegrity();
  assert.ok(audit.ok, JSON.stringify(audit));
});

test('o dado da partida e auditavel depois que a semente e revelada', async () => {
  const a = client(), b = client();
  await setup(a, 'ver1@t.com', 10000, 'ev-ver1');
  await setup(b, 'ver2@t.com', 10000, 'ev-ver2');
  const ch = (await a('POST', '/api/challenges', { stakeCents: 1000 })).body;
  await b('POST', `/api/challenges/${ch.code}/accept`);

  const players = { red: a, blue: b };
  let st = (await a('GET', `/api/challenges/${ch.code}`)).body;
  const seedHashDuranteJogo = st.seedHash;
  assert.ok(seedHashDuranteJogo, 'o compromisso existe desde o inicio');

  let guard = 0;
  while (!st.game.gameOver && guard++ < 4000) {
    const who = players[st.game.players[st.game.curIdx].color];
    st = st.game.dice == null
      ? (await who('POST', `/api/challenges/${ch.code}/roll`, { version: st.version })).body.state
      : (await who('POST', `/api/challenges/${ch.code}/move`, { tokenIdx: st.legalMoves[0], version: st.version })).body.state;
  }

  const fim = (await a('GET', `/api/challenges/${ch.code}`)).body;
  assert.ok(fim.serverSeed, 'a semente e revelada no fim');
  assert.equal(fim.seedHash, seedHashDuranteJogo, 'o compromisso nao mudou no meio da partida');

  // Recalcula todas as rolagens com a semente revelada e confere contra o historico.
  const { rollDie } = await import('../src/match.js');
  const rolls = db.prepare('SELECT nonce, value FROM dice_rolls WHERE code=? ORDER BY nonce').all(ch.code);
  assert.ok(rolls.length > 0);
  for (const r of rolls) {
    assert.equal(rollDie(fim.serverSeed, ch.code, r.nonce), r.value,
      `rolagem ${r.nonce} nao confere — o dado teria sido escolhido a dedo`);
  }
});

test('desistir no meio nao paga ninguem nem perde dinheiro', async () => {
  const a = client(), b = client();
  await setup(a, 'des1@t.com', 10000, 'ev-des1');
  await setup(b, 'des2@t.com', 10000, 'ev-des2');
  const ch = (await a('POST', '/api/challenges', { stakeCents: 3000 })).body;
  await b('POST', `/api/challenges/${ch.code}/accept`);

  // Partida comecou: cancelar nao e mais permitido.
  const r = await a('POST', `/api/challenges/${ch.code}/cancel`);
  assert.equal(r.body.error, 'NOT_OPEN');

  // O dinheiro continua preso no escrow, nao sumiu nem foi pago.
  assert.equal(balanceOf(escrowAccount(ch.code)), 6000);
  assert.ok(auditIntegrity().ok);
});
