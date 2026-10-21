/* Regressao dos achados da auditoria independente.
 *
 * Cada teste aqui reproduz um ataque que FUNCIONOU contra a versao anterior.
 * Se algum voltar a passar, a correcao foi desfeita.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-audit-'));
process.env.NODE_ENV = 'test';
delete process.env.PSP_WEBHOOK_SECRET;   // o cenario do achado #2: sem segredo

const server = (await import('../src/index.js')).default;
const { balanceOf, userAccount } = await import('../src/money.js');

await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (m, u, b, extra = {}) => {
    const s = m !== 'GET' && b !== undefined;
    const res = await fetch(BASE + u, {
      method: m,
      headers: {
        ...(s ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Origin: BASE, ...extra,
      },
      body: s ? JSON.stringify(b) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    const t = await res.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: res.status, body: j, cookie };
  };
}
const nova = async (email) => {
  const c = client();
  await c('POST', '/api/auth/register', { email, name: 'Audit', password: 'senha-forte-123' });
  return c;
};

/* ---- #2: webhook sem segredo tem de FALHAR FECHADO ---- */

test('[#2] sem PSP_WEBHOOK_SECRET, webhook nao assinado e RECUSADO', async () => {
  const c = await nova('fechado@t.com');
  const dep = await c('POST', '/api/wallet/deposit', { amountCents: 500000 });
  assert.equal(dep.status, 200);

  // O ataque exato que funcionava: o cliente recebe o `ref` e forja o evento.
  const r = await fetch(BASE + '/api/webhooks/psp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'forjado-1', type: 'payment.paid', data: { id: dep.body.ref, amount: 500000 } }),
  });
  assert.equal(r.status, 401, 'sem segredo configurado, nada pode ser aceito');

  const me = await c('GET', '/api/me');
  assert.equal(me.body.balanceCents, 0, 'R$5.000 nao podem ter sido creditados');
});

test('[#2] assinatura inventada tambem e recusada', async () => {
  const c = await nova('assin@t.com');
  const dep = await c('POST', '/api/wallet/deposit', { amountCents: 10000 });
  const body = JSON.stringify({ id: 'forjado-2', type: 'payment.paid', data: { id: dep.body.ref, amount: 10000 } });
  const r = await fetch(BASE + '/api/webhooks/psp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': createHmac('sha256', 'chute').update(body).digest('hex') },
    body,
  });
  assert.equal(r.status, 401);
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 0);
});

/* ---- #3: limite de deposito com cobrancas pendentes em paralelo ---- */

test('[#3] varios depositos pendentes nao furam o limite diario', async () => {
  const c = await nova('limite@t.com');
  await c('POST', '/api/me/limits', { dayCents: 10000, weekCents: null, monthCents: null });

  // O ataque: tres cobrancas de R$90 (cada uma sozinha cabe no limite de R$100),
  // criadas antes de qualquer uma virar 'paid'.
  const r1 = await c('POST', '/api/wallet/deposit', { amountCents: 9000 });
  const r2 = await c('POST', '/api/wallet/deposit', { amountCents: 9000 });
  const r3 = await c('POST', '/api/wallet/deposit', { amountCents: 9000 });

  assert.equal(r1.status, 200, 'a primeira cabe no limite');
  assert.equal(r2.body.error, 'LIMIT', 'a segunda ja estoura, contando a pendente');
  assert.equal(r3.body.error, 'LIMIT');
});

/* ---- #5: anti-CSRF quando nao vem header Origin ---- */

test('[#5] POST autenticado sem Origin e sem Referer e barrado', async () => {
  const c = await nova('csrf2@t.com');
  const cookie = (await c('GET', '/api/me')).cookie;

  const semOrigem = await fetch(BASE + '/api/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },  // nenhum Origin/Referer
    body: JSON.stringify({ stakeCents: 0 }),
  });
  assert.equal(semOrigem.status, 403);
  assert.equal((await semOrigem.json()).error, 'origem_ausente');

  // Com Referer da propria origem, passa.
  const comReferer = await fetch(BASE + '/api/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Referer: BASE + '/desafio.html' },
    body: JSON.stringify({ stakeCents: 0 }),
  });
  assert.equal(comReferer.status, 200);
});

test('[#5] Origin de outro site continua barrado', async () => {
  const c = await nova('csrf3@t.com');
  const cookie = (await c('GET', '/api/me')).cookie;
  const r = await fetch(BASE + '/api/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://site-malicioso.com' },
    body: JSON.stringify({ stakeCents: 0 }),
  });
  assert.equal(r.status, 403);
});

/* ---- #6: LIMIT negativo no extrato ---- */

test('[#6] ?limit=-1 nao vira "sem limite"', async () => {
  const c = await nova('ext@t.com');
  for (const v of ['-1', '0', '-999', 'abc', '99999']) {
    const r = await c('GET', `/api/wallet?limit=${v}`);
    assert.equal(r.status, 200, `limit=${v}`);
    assert.ok(r.body.entries.length <= 100, `limit=${v} devolveu ${r.body.entries.length} linhas`);
  }
});
