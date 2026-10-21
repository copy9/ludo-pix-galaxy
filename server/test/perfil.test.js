/* Perfil, maioridade, CPF e jogo responsavel — validados no servidor. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-perfil-'));
process.env.NODE_ENV = 'test';

const server = (await import('../src/index.js')).default;
const { validCPF, ageOf } = await import('../src/profile.js');

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
const novo = async (email) => {
  const c = client();
  await c('POST', '/api/auth/register', { email, name: 'Teste', password: 'senha-forte-123' });
  return c;
};
// Nascimento ha N anos, para o teste nao quebrar com o passar do tempo.
const anosAtras = (n) => {
  const d = new Date(); d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};
const CPF_OK = '52998224725';   // CPF valido pelos digitos verificadores

test('validador de CPF confere os digitos', () => {
  assert.ok(validCPF(CPF_OK));
  assert.ok(validCPF('111.444.777-35'));
  assert.ok(!validCPF('11111111111'), 'repetido tem de ser invalido');
  assert.ok(!validCPF('12345678900'), 'digito errado');
  assert.ok(!validCPF('123'), 'curto demais');
  assert.ok(!validCPF(''));
});

test('idade e calculada certo em volta do aniversario', () => {
  assert.equal(ageOf(anosAtras(18)), 18);
  assert.equal(ageOf(anosAtras(17)), 17);
  assert.equal(ageOf('nao-e-data'), -1);
});

test('menor de 18 nao completa o cadastro', async () => {
  const c = await novo('menor@t.com');
  const r = await c('POST', '/api/me/profile', {
    fullName: 'Joao Silva', cpf: CPF_OK, birth: anosAtras(17),
    phone: '51999998888', country: 'BR',
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'UNDERAGE');
  assert.equal((await c('GET', '/api/me/profile')).body.kycLevel, 1, 'continua no nivel 1');
});

test('CPF invalido e recusado pelo servidor', async () => {
  const c = await novo('cpfruim@t.com');
  const r = await c('POST', '/api/me/profile', {
    fullName: 'Joao Silva', cpf: '12345678900', birth: anosAtras(30),
    phone: '51999998888', country: 'BR',
  });
  assert.equal(r.body.error, 'BAD_PROFILE');
});

test('cadastro completo sobe para o nivel 2 e o CPF volta mascarado', async () => {
  const c = await novo('ok@t.com');
  const r = await c('POST', '/api/me/profile', {
    fullName: 'Maria Souza', cpf: CPF_OK, birth: anosAtras(30),
    phone: '51999998888', country: 'BR',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.kycLevel, 2);
  assert.match(r.body.cpf, /^\*\*\*\./, 'CPF nao pode voltar inteiro');
  assert.ok(!r.body.cpf.includes(CPF_OK.slice(0, 3)));
});

test('o mesmo CPF nao abre duas contas', async () => {
  const a = await novo('cpf1@t.com');
  const b = await novo('cpf2@t.com');
  const dados = { fullName: 'Ana Lima', cpf: '111.444.777-35', birth: anosAtras(25), phone: '51988887777', country: 'BR' };
  assert.equal((await a('POST', '/api/me/profile', dados)).status, 200);
  const r = await b('POST', '/api/me/profile', dados);
  assert.equal(r.body.error, 'CPF_TAKEN', 'segunda conta com o mesmo CPF e barrada');
});

test('KYC nao pode ser promovido pelo proprio cliente', async () => {
  const c = await novo('kyc@t.com');
  await c('POST', '/api/me/profile', {
    fullName: 'Carlos Dias', cpf: CPF_OK.replace('52998224725', '111.444.777-35'),
    birth: anosAtras(40), phone: '51977776666', country: 'BR',
  });
  // Tenta forcar o nivel 3 por varios caminhos.
  await c('POST', '/api/me/kyc', { docType: 'rg', kycLevel: 3 });
  await c('POST', '/api/me/profile', { kycLevel: 3, fullName: 'Carlos Dias', cpf: '111.444.777-35', birth: anosAtras(40), phone: '51977776666', country: 'BR' });
  const p = await c('GET', '/api/me/profile');
  assert.ok(p.body.kycLevel < 3, 'so o provedor de KYC promove ao nivel 3');
});

test('autoexclusao bloqueia apostar e nao pode ser encurtada', async () => {
  const c = await novo('excl@t.com');
  const r = await c('POST', '/api/me/self-exclude', { days: 90 });
  assert.equal(r.status, 200);

  const ch = await c('POST', '/api/challenges', { stakeCents: 1000 });
  assert.equal(ch.body.error, 'autoexcluido', 'conta excluida nao aposta');

  const dep = await c('POST', '/api/wallet/deposit', { amountCents: 5000 });
  assert.equal(dep.body.error, 'SELF_EXCLUDED', 'nem deposita');

  const curto = await c('POST', '/api/me/self-exclude', { days: 30 });
  assert.equal(curto.status, 403, 'nao da para encurtar a autoexclusao');
});

test('autoexclusao recusa prazo fora da faixa', async () => {
  const c = await novo('excl2@t.com');
  assert.equal((await c('POST', '/api/me/self-exclude', { days: 5 })).body.error, 'BAD_AMOUNT');
  assert.equal((await c('POST', '/api/me/self-exclude', { days: 99999 })).body.error, 'BAD_AMOUNT');
});

test('limite de deposito: reduzir vale na hora, aumentar tem carencia', async () => {
  const c = await novo('lim@t.com');
  assert.equal((await c('POST', '/api/me/limits', { dayCents: 50000, weekCents: 200000, monthCents: 500000 })).status, 200);
  // Reduzir e imediato.
  assert.equal((await c('POST', '/api/me/limits', { dayCents: 10000, weekCents: 50000, monthCents: 100000 })).status, 200);
  // Aumentar, nao.
  const up = await c('POST', '/api/me/limits', { dayCents: 999999, weekCents: 999999, monthCents: 999999 });
  assert.equal(up.body.error, 'LIMIT_COOLDOWN');
});

test('limite diario nao pode passar do semanal', async () => {
  const c = await novo('lim2@t.com');
  const r = await c('POST', '/api/me/limits', { dayCents: 100000, weekCents: 10000, monthCents: 500000 });
  assert.equal(r.body.error, 'BAD_AMOUNT');
});

test('limite de deposito e respeitado de verdade', async () => {
  const c = await novo('lim3@t.com');
  await c('POST', '/api/me/limits', { dayCents: 10000, weekCents: null, monthCents: null });
  assert.equal((await c('POST', '/api/wallet/deposit', { amountCents: 20000 })).body.error, 'LIMIT');
  assert.equal((await c('POST', '/api/wallet/deposit', { amountCents: 5000 })).status, 200);
});
