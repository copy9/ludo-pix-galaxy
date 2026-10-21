/* Testes de ponta a ponta contra o servidor HTTP de verdade.
 * Inclui as tentativas de fraude que o sistema antigo permitia.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-api-'));
process.env.PSP_WEBHOOK_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const server = (await import('../src/index.js')).default;
const { db } = await import('../src/db.js');

await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

/** Cliente HTTP que guarda cookie, como um navegador. */
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const sendsBody = method !== 'GET' && method !== 'HEAD' && body !== undefined;
    const res = await fetch(BASE + url, {
      method,
      headers: {
        ...(sendsBody ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Origin: BASE,
      },
      body: sendsBody ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) cookie = c.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const register = async (c, email, name) =>
  c('POST', '/api/auth/register', { email, name, password: 'senha-forte-123' });

/** Credita saldo pelo caminho real: webhook assinado do gateway. */
async function depositViaWebhook(c, amountCents, eventId) {
  const dep = await c('POST', '/api/wallet/deposit', { amountCents });
  assert.equal(dep.status, 200, JSON.stringify(dep.body));
  const payload = JSON.stringify({
    id: eventId, type: 'payment.paid',
    data: { id: dep.body.ref, amount: amountCents, status: 'paid' },
  });
  const sig = createHmac('sha256', process.env.PSP_WEBHOOK_SECRET).update(payload).digest('hex');
  const res = await fetch(BASE + '/api/webhooks/psp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: payload,
  });
  return { res, payload, sig };
}

/* ------------------------------------------------------------ contas */

test('registro, sessao e logout', async () => {
  const c = client();
  const r = await register(c, 'ana@t.com', 'Ana');
  assert.equal(r.status, 200);

  const me = await c('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'ana@t.com');
  assert.equal(me.body.balanceCents, 0);

  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/me')).status, 401);
});

test('senha fraca e recusada', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: 'f@t.com', name: 'Fraco', password: '123456' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'senha_fraca');
});

test('registro duplicado nao revela que o e-mail existe', async () => {
  const c = client();
  await register(c, 'dup@t.com', 'Dup');
  const r = await c('POST', '/api/auth/register', { email: 'dup@t.com', name: 'Outro', password: 'senha-forte-123' });
  assert.equal(r.body.error, 'nao_foi_possivel');
  assert.ok(!JSON.stringify(r.body).match(/existe|cadastrad|duplicad/i),
    'a resposta nao pode confirmar que o e-mail tem conta');
});

test('a senha nunca volta numa resposta', async () => {
  const c = client();
  const r = await register(c, 'leak@t.com', 'Leak');
  const dump = JSON.stringify(r.body) + JSON.stringify((await c('GET', '/api/me')).body);
  assert.ok(!/pass_hash|pass_salt|senha-forte/.test(dump), 'vazou material de senha');
});

/* -------------------------------------------- deposito e seguranca */

test('deposito so credita por webhook assinado', async () => {
  const c = client();
  await register(c, 'dep@t.com', 'Dep');

  const dep = await c('POST', '/api/wallet/deposit', { amountCents: 10000 });
  assert.equal(dep.status, 200);
  // Pedir o deposito NAO credita: o dinheiro ainda nao chegou.
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 0);

  // Webhook com assinatura errada e rejeitado.
  const forjado = JSON.stringify({ id: 'ev-falso', type: 'payment.paid', data: { id: dep.body.ref, amount: 10000, status: 'paid' } });
  const bad = await fetch(BASE + '/api/webhooks/psp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'deadbeef' }, body: forjado,
  });
  assert.equal(bad.status, 401, 'assinatura invalida tem de ser recusada');
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 0, 'nada creditado');

  // Com a assinatura correta, credita.
  const sig = createHmac('sha256', process.env.PSP_WEBHOOK_SECRET).update(forjado).digest('hex');
  const good = await fetch(BASE + '/api/webhooks/psp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: forjado,
  });
  assert.equal(good.status, 200);
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 10000);
});

test('webhook reenviado nao credita duas vezes', async () => {
  const c = client();
  await register(c, 'reenvio@t.com', 'Reenvio');
  const { payload, sig } = await depositViaWebhook(c, 5000, 'ev-reenvio-1');

  for (let i = 0; i < 4; i++) {
    await fetch(BASE + '/api/webhooks/psp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: payload,
    });
  }
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 5000, 'cinco entregas, um credito');
});

test('webhook com valor diferente do cobrado nao credita', async () => {
  const c = client();
  await register(c, 'valor@t.com', 'Valor');
  const dep = await c('POST', '/api/wallet/deposit', { amountCents: 1000 });

  // Evento assinado corretamente, mas dizendo um valor maior que o cobrado.
  const payload = JSON.stringify({ id: 'ev-valor', type: 'payment.paid', data: { id: dep.body.ref, amount: 999999, status: 'paid' } });
  const sig = createHmac('sha256', process.env.PSP_WEBHOOK_SECRET).update(payload).digest('hex');
  const r = await fetch(BASE + '/api/webhooks/psp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: payload,
  });
  assert.equal(r.status, 200);
  assert.match(JSON.stringify(await r.json()), /divergente/);
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 0);
});

/* ---------------------------------------- tentativas de fraude */

test('FRAUDE: cliente nao consegue inventar saldo', async () => {
  const c = client();
  await register(c, 'fraude@t.com', 'Fraude');
  await depositViaWebhook(c, 1000, 'ev-fraude-1');

  // Era exatamente isto que o sistema antigo permitia: o navegador escrevia o
  // proprio saldo. Hoje nao existe rota que aceite um saldo vindo do cliente.
  for (const [m, url, body] of [
    ['POST', '/api/wallet', { balanceCents: 999999 }],
    ['POST', '/api/me', { balanceCents: 999999 }],
    ['POST', '/api/wallet/balance', { balanceCents: 999999 }],
    ['POST', '/api/wallet/deposit', { amountCents: 1000, balanceCents: 999999 }],
  ]) {
    await c(m, url, body);
  }
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 1000, 'saldo intacto');
});

test('FRAUDE: nao da para sacar mais do que tem', async () => {
  const c = client();
  await register(c, 'saque@t.com', 'Saque');
  await depositViaWebhook(c, 2000, 'ev-saque-1');
  db.prepare("UPDATE users SET kyc_level=3 WHERE email='saque@t.com'").run();

  const r = await c('POST', '/api/wallet/withdraw', { amountCents: 500000, pixKey: 'x@y.com' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'INSUFFICIENT_FUNDS');
  assert.equal((await c('GET', '/api/me')).body.balanceCents, 2000);
});

test('FRAUDE: saque exige conta verificada', async () => {
  const c = client();
  await register(c, 'semkyc@t.com', 'SemKyc');
  await depositViaWebhook(c, 5000, 'ev-semkyc-1');
  const r = await c('POST', '/api/wallet/withdraw', { amountCents: 1000, pixKey: 'x@y.com' });
  assert.equal(r.body.error, 'KYC_REQUIRED');
});

test('FRAUDE: nao da para se declarar vencedor', async () => {
  const a = client(), b = client();
  await register(a, 'j1@t.com', 'J1');
  await register(b, 'j2@t.com', 'J2');
  await depositViaWebhook(a, 10000, 'ev-j1');
  await depositViaWebhook(b, 10000, 'ev-j2');

  const ch = await a('POST', '/api/challenges', { stakeCents: 5000 });
  await b('POST', `/api/challenges/${ch.body.code}/accept`);

  // Nao existe rota para declarar vencedor: quem decide e o servidor, ao fim da
  // partida. No sistema antigo, bastava clicar "Eu venci".
  for (const url of [
    `/api/challenges/${ch.body.code}/resolve`,
    `/api/challenges/${ch.body.code}/report`,
    `/api/challenges/${ch.body.code}/win`,
  ]) {
    const r = await a('POST', url, { winnerId: 'eu' });
    assert.ok(r.status === 404, `rota ${url} nao deveria existir`);
  }
  const st = await a('GET', `/api/challenges/${ch.body.code}`);
  assert.equal(st.body.status, 'both_staked', 'partida continua em aberto');
  assert.equal((await a('GET', '/api/me')).body.balanceCents, 5000, 'nada foi pago');
});

test('FRAUDE: a semente do dado so aparece no fim', async () => {
  const a = client(), b = client();
  await register(a, 's1@t.com', 'S1');
  await register(b, 's2@t.com', 'S2');
  await depositViaWebhook(a, 5000, 'ev-s1');
  await depositViaWebhook(b, 5000, 'ev-s2');
  const ch = await a('POST', '/api/challenges', { stakeCents: 1000 });
  await b('POST', `/api/challenges/${ch.body.code}/accept`);

  const st = await a('GET', `/api/challenges/${ch.body.code}`);
  assert.ok(st.body.seedHash, 'o compromisso e publicado desde o inicio');
  assert.equal(st.body.serverSeed, undefined, 'a semente fica escondida durante a partida');
  assert.ok(!JSON.stringify(st.body).includes('serverSeed":"'), 'semente nao pode vazar no estado');
});

test('FRAUDE: nao da para jogar na partida dos outros', async () => {
  const a = client(), b = client(), x = client();
  await register(a, 'm1@t.com', 'M1');
  await register(b, 'm2@t.com', 'M2');
  await register(x, 'intruso@t.com', 'Intruso');
  await depositViaWebhook(a, 5000, 'ev-m1');
  await depositViaWebhook(b, 5000, 'ev-m2');
  const ch = await a('POST', '/api/challenges', { stakeCents: 1000 });
  await b('POST', `/api/challenges/${ch.body.code}/accept`);

  assert.equal((await x('POST', `/api/challenges/${ch.body.code}/roll`)).body.error, 'FORBIDDEN');
  assert.equal((await b('POST', `/api/challenges/${ch.body.code}/roll`)).body.error, 'NOT_YOUR_TURN');
});

test('FRAUDE: jogada ilegal e recusada pelo servidor', async () => {
  const a = client(), b = client();
  await register(a, 'i1@t.com', 'I1');
  await register(b, 'i2@t.com', 'I2');
  await depositViaWebhook(a, 5000, 'ev-i1');
  await depositViaWebhook(b, 5000, 'ev-i2');
  const ch = await a('POST', '/api/challenges', { stakeCents: 1000 });
  await b('POST', `/api/challenges/${ch.body.code}/accept`);

  // Mover sem ter rolado o dado.
  const r = await a('POST', `/api/challenges/${ch.body.code}/move`, { tokenIdx: 0 });
  assert.equal(r.body.error, 'NO_DICE');

  // Indice de peca fora da faixa.
  await a('POST', `/api/challenges/${ch.body.code}/roll`);
  const r2 = await a('POST', `/api/challenges/${ch.body.code}/move`, { tokenIdx: 99 });
  assert.ok(['ILLEGAL_MOVE', 'NOT_YOUR_TURN'].includes(r2.body.error), r2.body.error);
});

test('FRAUDE: nao da para aceitar o proprio desafio e dobrar o dinheiro', async () => {
  const c = client();
  await register(c, 'solo@t.com', 'Solo');
  await depositViaWebhook(c, 10000, 'ev-solo');
  const ch = await c('POST', '/api/challenges', { stakeCents: 2000 });
  const r = await c('POST', `/api/challenges/${ch.body.code}/accept`);
  assert.equal(r.body.error, 'SELF_ACCEPT');
});

/* ------------------------------------------------- outras protecoes */

test('rota protegida exige sessao', async () => {
  const anon = client();
  for (const [m, url] of [['GET','/api/me'], ['GET','/api/wallet'], ['POST','/api/challenges']]) {
    assert.equal((await anon(m, url, {})).status, 401, url);
  }
});

test('POST de outra origem e barrado (CSRF)', async () => {
  const c = client();
  await register(c, 'csrf@t.com', 'Csrf');
  const me = await c('GET', '/api/me');
  const res = await fetch(BASE + '/api/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://site-malicioso.com' },
    body: JSON.stringify({ stakeCents: 100 }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origem_nao_permitida');
  assert.ok(me.status === 200);
});

test('nao serve o codigo do servidor nem o banco', async () => {
  for (const p of ['/server/src/index.js', '/server/data/ludopix.db', '/.git/config',
                   '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const r = await fetch(BASE + p);
    assert.ok(r.status === 404 || r.status === 403, `${p} devolveu ${r.status}`);
  }
});

test('serve o front e manda os cabecalhos de seguranca', async () => {
  const r = await fetch(BASE + '/index.html');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
});

test('o razao continua integro depois de tudo', async () => {
  const r = await (await fetch(BASE + '/api/_audit')).json();
  assert.deepEqual(r.unbalanced, []);
  assert.deepEqual(r.drifted, []);
  assert.equal(r.grandTotal, 0);
  assert.ok(r.ok);
});
