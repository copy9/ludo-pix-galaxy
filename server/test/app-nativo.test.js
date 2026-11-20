/* Autenticacao do app nativo (Bearer) e CORS.
 *
 * O app empacotado roda em capacitor://localhost e fala com a API em outro
 * dominio, entao nao tem cookie para usar. Estes testes cobrem o transporte
 * alternativo e, principalmente, que ele NAO abriu um buraco de CSRF.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-nativo-'));
process.env.NODE_ENV = 'test';

const server = (await import('../src/index.js')).default;
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const APP = 'capacitor://localhost';

/** Cliente do app nativo: sem cookie, so token no cabecalho. */
function appNativo() {
  let token = null;
  const call = async (m, u, b) => {
    const envia = m !== 'GET' && b !== undefined;
    const res = await fetch(BASE + u, {
      method: m,
      headers: {
        ...(envia ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Auth-Mode': 'token',
        Origin: APP,
      },
      body: envia ? JSON.stringify(b) : undefined,
    });
    const t = await res.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    if (j && j.token) token = j.token;
    return { status: res.status, body: j, headers: res.headers };
  };
  call.token = () => token;
  call.esquecer = () => { token = null; };
  return call;
}

test('app nativo cria conta e recebe o token no corpo', async () => {
  const app = appNativo();
  const r = await app('POST', '/api/auth/register', { email: 'nat@t.com', name: 'Nativo', password: 'senha-forte-123' });
  assert.equal(r.status, 200);
  assert.ok(r.body.token, 'com X-Auth-Mode: token o servidor devolve o token');
  assert.ok(r.body.expiresAt > Date.now());
});

test('o token autentica sem nenhum cookie', async () => {
  const app = appNativo();
  await app('POST', '/api/auth/register', { email: 'nat2@t.com', name: 'Nativo2', password: 'senha-forte-123' });
  const me = await app('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'nat2@t.com');
});

test('sem token nao passa', async () => {
  const app = appNativo();
  await app('POST', '/api/auth/register', { email: 'nat3@t.com', name: 'Nativo3', password: 'senha-forte-123' });
  app.esquecer();
  assert.equal((await app('GET', '/api/me')).status, 401);
});

test('token invalido ou mal formado nao passa', async () => {
  for (const h of ['Bearer lixo', 'Bearer ', 'Basic abc', 'Bearer ' + 'a'.repeat(300)]) {
    const res = await fetch(BASE + '/api/me', { headers: { Authorization: h, Origin: APP } });
    assert.equal(res.status, 401, `cabecalho: ${h.slice(0, 20)}`);
  }
});

test('navegador NAO recebe o token no corpo (sem X-Auth-Mode)', async () => {
  // A web usa cookie httpOnly: devolver o token la permitiria a um XSS le-lo.
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: 'web@t.com', name: 'Web', password: 'senha-forte-123' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.token, undefined, 'token nao pode vazar para o cliente web');
  assert.ok(res.headers.getSetCookie().some((c) => c.includes('HttpOnly')), 'a web continua no cookie httpOnly');
});

test('logout encerra a sessao do token, nao a do cookie', async () => {
  const app = appNativo();
  await app('POST', '/api/auth/register', { email: 'nat4@t.com', name: 'Nativo4', password: 'senha-forte-123' });
  const tk = app.token();
  assert.equal((await app('GET', '/api/me')).status, 200);
  await app('POST', '/api/auth/logout', {});
  // O token foi destruido no servidor, mesmo ainda estando guardado no cliente.
  const res = await fetch(BASE + '/api/me', { headers: { Authorization: `Bearer ${tk}`, Origin: APP } });
  assert.equal(res.status, 401);
});

/* ------------------------------------------------------------- CORS */

test('CORS liberado para a origem do app, com credenciais', async () => {
  const res = await fetch(BASE + '/api/health', { headers: { Origin: APP } });
  assert.equal(res.headers.get('access-control-allow-origin'), APP);
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  assert.match(res.headers.get('vary') || '', /Origin/);
});

test('preflight responde o que o app precisa', async () => {
  const res = await fetch(BASE + '/api/challenges', {
    method: 'OPTIONS',
    headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers') || '', /Authorization/i);
  assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
});

test('site desconhecido NAO ganha CORS', async () => {
  const res = await fetch(BASE + '/api/health', { headers: { Origin: 'https://site-malicioso.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null,
    'nunca refletir a origem recebida: isso equivale a liberar geral');

  const pre = await fetch(BASE + '/api/challenges', {
    method: 'OPTIONS', headers: { Origin: 'https://site-malicioso.com', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(pre.status, 403);
});

test('nunca responde com Allow-Origin: *', async () => {
  for (const o of [APP, 'https://x.com', undefined]) {
    const res = await fetch(BASE + '/api/health', { headers: o ? { Origin: o } : {} });
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  }
});

/* ------------------------------------------- CSRF nao pode ter afrouxado */

test('CSRF: a excecao do Bearer nao vale quando a credencial e o cookie', async () => {
  // Abre sessao por cookie, como um navegador.
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: 'vitima@t.com', name: 'Vitima', password: 'senha-forte-123' }),
  });
  const cookie = reg.headers.getSetCookie()[0].split(';')[0];

  // Site malicioso tenta usar o cookie da vitima e anexa um Authorization
  // qualquer, torcendo para que isso pule a checagem de origem.
  const ataque = await fetch(BASE + '/api/challenges', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Authorization: 'Bearer invencao-do-atacante',
      Origin: 'https://site-malicioso.com',
    },
    body: JSON.stringify({ stakeCents: 0 }),
  });
  // Tem de falhar: ou 401 (o Bearer falso nao autentica) ou 403 (origem barrada).
  // O que nao pode acontecer e 200.
  assert.notEqual(ataque.status, 200, 'Authorization forjado nao pode destravar o cookie');
  assert.ok([401, 403].includes(ataque.status), `status inesperado: ${ataque.status}`);
});

test('CSRF: POST por cookie de outra origem continua barrado', async () => {
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: 'vitima2@t.com', name: 'Vitima2', password: 'senha-forte-123' }),
  });
  const cookie = reg.headers.getSetCookie()[0].split(';')[0];
  const r = await fetch(BASE + '/api/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://site-malicioso.com' },
    body: JSON.stringify({ stakeCents: 0 }),
  });
  assert.equal(r.status, 403);
});

test('o app nativo consegue jogar de ponta a ponta so com token', async () => {
  const a = appNativo(), b = appNativo();
  await a('POST', '/api/auth/register', { email: 'na@t.com', name: 'Jog A', password: 'senha-forte-123' });
  await b('POST', '/api/auth/register', { email: 'nb@t.com', name: 'Jog B', password: 'senha-forte-123' });

  const ch = await a('POST', '/api/challenges', { stakeCents: 0 });   // amistoso
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal((await b('POST', `/api/challenges/${ch.body.code}/accept`, {})).status, 200);

  const st = await a('GET', `/api/challenges/${ch.body.code}`);
  assert.equal(st.status, 200);
  assert.equal(st.body.yourColor, 'red');
  assert.equal((await a('POST', `/api/challenges/${ch.body.code}/roll`, { version: st.body.version })).status, 200);
});
