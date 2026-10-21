import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, needsRehash, blindIndex } from '../src/lib/passwords.js';

test('a senha correta passa e a errada não', async () => {
  const hash = await hashPassword('uma senha bem longa 123');
  assert.equal(await verifyPassword('uma senha bem longa 123', hash), true);
  assert.equal(await verifyPassword('uma senha bem longa 124', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('a mesma senha gera hashes diferentes — o salt é aleatório', async () => {
  const a = await hashPassword('senha repetida aqui');
  const b = await hashPassword('senha repetida aqui');
  assert.notEqual(a, b, 'sem salt único, senhas iguais teriam hash igual');
  assert.equal(await verifyPassword('senha repetida aqui', a), true);
  assert.equal(await verifyPassword('senha repetida aqui', b), true);
});

test('o hash carrega os parâmetros de custo', async () => {
  const hash = await hashPassword('senha de exemplo!');
  const [alg, N, r, p] = hash.split('$');
  assert.equal(alg, 'scrypt');
  assert.equal(Number(N), 32768, 'custo de memória alto o suficiente');
  assert.ok(Number(r) >= 8 && Number(p) >= 1);
});

test('hash malformado é rejeitado sem explodir', async () => {
  for (const bad of ['', 'x', 'scrypt$a$b$c$d$e', 'sha256$1$1$1$aa$bb', 'scrypt$1$1$1$$', null, undefined, 42]) {
    assert.equal(await verifyPassword('qualquer coisa', bad), false, `falhou em ${JSON.stringify(bad)}`);
  }
});

test('um N absurdo no banco não trava o processo', async () => {
  const bomb = `scrypt$${2 ** 25}$8$1$${Buffer.from('salt').toString('base64url')}$${Buffer.from('x'.repeat(64)).toString('base64url')}`;
  assert.equal(await verifyPassword('qualquer', bomb), false);
});

test('senhas equivalentes em Unicode normalizam igual', async () => {
  // "café" com e-acento composto vs. decomposto: o usuário digitou a mesma coisa.
  const composed = 'café secreto 12345';
  const decomposed = 'café secreto 12345';
  const hash = await hashPassword(composed);
  assert.equal(await verifyPassword(decomposed, hash), true);
});

test('needsRehash aponta hash antigo ou de outro algoritmo', async () => {
  assert.equal(needsRehash(await hashPassword('senha atual aqui')), false);
  assert.equal(needsRehash('scrypt$16384$8$1$aa$bb'), true, 'custo menor precisa subir');
  assert.equal(needsRehash('sha256$abc'), true, 'o formato antigo do protótipo');
  assert.equal(needsRehash(undefined), true);
});

test('blindIndex é determinístico e depende do segredo', () => {
  const a = blindIndex('segredo-do-servidor', '12345678909');
  const b = blindIndex('segredo-do-servidor', '12345678909');
  const c = blindIndex('outro-segredo', '12345678909');
  assert.equal(a, b, 'precisa ser determinístico para achar duplicados');
  assert.notEqual(a, c, 'sem a chave do servidor, o índice não se reproduz');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.throws(() => blindIndex('', '123'), /segredo/);
});

test('verificar senha custa tempo — não é um hash rápido', async () => {
  const hash = await hashPassword('medindo o custo aqui');
  const start = process.hrtime.bigint();
  await verifyPassword('medindo o custo aqui', hash);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // Um SHA-256 puro levaria microssegundos. Se isso cair abaixo de 10 ms,
  // o custo foi afrouxado por engano e senhas viram alvo fácil de GPU.
  assert.ok(ms > 10, `verificação rápida demais (${ms.toFixed(1)} ms) — custo fraco`);
});
