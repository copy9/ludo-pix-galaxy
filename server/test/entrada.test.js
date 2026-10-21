/* Entrada malformada.
 *
 * O cliente e hostil por definicao. Tudo que chega dele pode ser do tipo
 * errado, do tamanho errado, ou nao ser um numero. Nada disso pode virar
 * dinheiro, estado invalido ou erro 500.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-input-'));
process.env.PSP_WEBHOOK_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const server = (await import('../src/index.js')).default;
const { auditIntegrity, balanceOf, userAccount } = await import('../src/money.js');

await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = '';
  const f = async (method, url, body) => {
    const sends = method !== 'GET' && body !== undefined;
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(sends ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: BASE },
      body: sends ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    const t = await res.text();
    let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
    return { status: res.status, body: b };
  };
  f.id = null;
  return f;
}

async function conta(email, cents) {
  const c = client();
  await c('POST', '/api/auth/register', { email, name: 'Teste', password: 'senha-forte-123' });
  c.id = (await c('GET', '/api/me')).body.id;
  if (cents) {
    const dep = await c('POST', '/api/wallet/deposit', { amountCents: cents });
    const p = JSON.stringify({ id: 'ev-' + email, type: 'payment.paid', data: { id: dep.body.ref, amount: cents, status: 'paid' } });
    const sig = createHmac('sha256', process.env.PSP_WEBHOOK_SECRET).update(p).digest('hex');
    await fetch(BASE + '/api/webhooks/psp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: p });
  }
  return c;
}

/* Valores que um cliente hostil manda onde se espera um numero. */
const LIXO = [
  null, undefined, '', 'abc', '1e309', NaN, Infinity, -Infinity,
  -1, -0.5, 0.1, 1.5, 1e21, Number.MAX_SAFE_INTEGER + 1,
  '100; DROP TABLE users', '<script>alert(1)</script>',
  [], {}, [1, 2], { toString: 'x' }, true, false,
];

test('valor de aposta invalido nunca cria desafio com dinheiro', async () => {
  const c = await conta('aposta@t.com', 50000);
  const antes = balanceOf(userAccount(c.id));

  for (const v of LIXO) {
    const r = await c('POST', '/api/challenges', { stakeCents: v });
    assert.notEqual(r.status, 500, `500 com stakeCents=${JSON.stringify(v)}`);
    if (r.status === 200) {
      // So pode ter passado como desafio GRATIS (valor zero).
      assert.equal(r.body.stakeCents, 0, `stakeCents=${JSON.stringify(v)} virou aposta de verdade`);
    }
  }
  assert.equal(balanceOf(userAccount(c.id)), antes, 'nenhum centavo saiu');
  assert.ok(auditIntegrity().ok);
});

test('valor de deposito invalido e sempre recusado', async () => {
  const c = await conta('dep-lixo@t.com');
  for (const v of LIXO) {
    const r = await c('POST', '/api/wallet/deposit', { amountCents: v });
    assert.notEqual(r.status, 500, `500 com amountCents=${JSON.stringify(v)}`);
    assert.notEqual(r.status, 200, `aceitou deposito com ${JSON.stringify(v)}`);
  }
  assert.equal(balanceOf(userAccount(c.id)), 0);
});

test('valor de saque invalido e sempre recusado', async () => {
  const c = await conta('saq-lixo@t.com', 50000);
  const antes = balanceOf(userAccount(c.id));
  for (const v of LIXO) {
    const r = await c('POST', '/api/wallet/withdraw', { amountCents: v, pixKey: 'x@y.com' });
    assert.notEqual(r.status, 500, `500 com amountCents=${JSON.stringify(v)}`);
    assert.notEqual(r.status, 200, `aceitou saque com ${JSON.stringify(v)}`);
  }
  assert.equal(balanceOf(userAccount(c.id)), antes, 'saldo intacto');
});

test('tokenIdx malformado nao quebra a partida nem passa jogada', async () => {
  const a = await conta('tk1@t.com', 20000);
  const b = await conta('tk2@t.com', 20000);
  const ch = (await a('POST', '/api/challenges', { stakeCents: 1000 })).body;
  await b('POST', `/api/challenges/${ch.code}/accept`);

  // Garante que ha um dado posto e e a vez de 'a'.
  let st = (await a('GET', `/api/challenges/${ch.code}`)).body;
  if (st.game.dice == null) {
    const r = await a('POST', `/api/challenges/${ch.code}/roll`, { version: st.version });
    if (r.status === 200) st = r.body.state;
  }
  const versaoAntes = st.version;

  for (const v of LIXO) {
    const r = await a('POST', `/api/challenges/${ch.code}/move`, { tokenIdx: v, version: st.version });
    assert.notEqual(r.status, 500, `500 com tokenIdx=${JSON.stringify(v)}`);
    assert.notEqual(r.status, 200, `aceitou jogada com tokenIdx=${JSON.stringify(v)}`);
  }
  const depois = (await a('GET', `/api/challenges/${ch.code}`)).body;
  assert.equal(depois.version, versaoAntes, 'nenhuma jogada invalida mexeu no estado');
  assert.ok(auditIntegrity().ok);
});

test('version malformado nao burla a trava otimista', async () => {
  const a = await conta('vs1@t.com', 20000);
  const b = await conta('vs2@t.com', 20000);
  const ch = (await a('POST', '/api/challenges', { stakeCents: 1000 })).body;
  await b('POST', `/api/challenges/${ch.code}/accept`);
  const st = (await a('GET', `/api/challenges/${ch.code}`)).body;

  await a('POST', `/api/challenges/${ch.code}/roll`, { version: st.version });
  // Tenta rolar de novo mandando lixo no lugar da versao.
  for (const v of [null, 'abc', {}, [], -1, 1e21, true]) {
    const r = await a('POST', `/api/challenges/${ch.code}/roll`, { version: v });
    assert.notEqual(r.status, 500, `500 com version=${JSON.stringify(v)}`);
  }
  const rolls = (await a('GET', `/api/challenges/${ch.code}`)).body;
  assert.ok(rolls.version <= st.version + 2, 'lixo na versao nao deve render rolagens extras');
});

test('codigo de desafio estranho nao quebra nem vaza', async () => {
  const c = await conta('cod@t.com');
  for (const code of ['../../etc/passwd', '%2e%2e%2f', "' OR 1=1 --", 'A'.repeat(500), '🎲🎲', '']) {
    const r = await c('GET', `/api/challenges/${encodeURIComponent(code)}`);
    assert.notEqual(r.status, 500, `500 com code=${code}`);
    assert.ok([400, 404].includes(r.status), `code=${code} devolveu ${r.status}`);
  }
});

test('JSON invalido e corpo gigante nao derrubam o servidor', async () => {
  const c = await conta('json@t.com');

  const ruim = await fetch(BASE + '/api/challenges', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{nao e json',
  });
  assert.equal(ruim.status, 400);

  const gigante = await fetch(BASE + '/api/challenges', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ stakeCents: 100, lixo: 'x'.repeat(500000) }),
  }).catch(() => ({ status: 413 }));
  assert.ok([400, 413].includes(gigante.status), `corpo gigante devolveu ${gigante.status}`);

  // O servidor continua de pe.
  assert.equal((await fetch(BASE + '/api/health')).status, 200);
});

test('campos de texto absurdos sao cortados, nao estouram', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/register', {
    email: 'longo@t.com', name: 'N'.repeat(10000), password: 'senha-forte-123',
  });
  assert.notEqual(r.status, 500);
  if (r.status === 200) assert.ok(r.body.name.length <= 40, 'nome tem de ser cortado');
});

test('o razao segue integro depois de todo o lixo', () => {
  assert.ok(auditIntegrity().ok, JSON.stringify(auditIntegrity()));
});
