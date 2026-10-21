import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, __resetKeyCache } from '../src/lib/crypto-box.js';

const SECRET = 'um-segredo-mestre-bem-longo-para-teste-0123456789';

test('o que foi cifrado volta igual', () => {
  const sealed = seal(SECRET, '12345678909', { purpose: 'pix-key' });
  assert.equal(open(SECRET, sealed, { purpose: 'pix-key' }), '12345678909');
});

test('o texto cifrado não contém o valor original', () => {
  const sealed = seal(SECRET, 'chave-secreta@email.com', { purpose: 'pix-key' });
  assert.ok(!sealed.includes('chave-secreta'), 'o valor vazou no texto cifrado');
  assert.ok(!sealed.includes('email.com'));
});

test('cifrar o mesmo valor duas vezes dá resultados diferentes', () => {
  const a = seal(SECRET, '12345678909', { purpose: 'pix-key' });
  const b = seal(SECRET, '12345678909', { purpose: 'pix-key' });
  assert.notEqual(a, b, 'IV aleatório impede identificar valores repetidos no banco');
});

test('adulterar o texto cifrado faz a decifragem falhar', () => {
  const sealed = seal(SECRET, '12345678909', { purpose: 'pix-key' });
  const parts = sealed.split('.');
  const data = Buffer.from(parts[3], 'base64url');
  data[0] ^= 0xff; // vira um bit
  const tampered = [parts[0], parts[1], parts[2], data.toString('base64url')].join('.');
  assert.throws(() => open(SECRET, tampered, { purpose: 'pix-key' }));
});

test('texto cifrado de outro usuário não decifra — o aad amarra ao dono', () => {
  const sealed = seal(SECRET, '12345678909', { purpose: 'pix-key', aad: 'usuario-A' });
  assert.equal(open(SECRET, sealed, { purpose: 'pix-key', aad: 'usuario-A' }), '12345678909');
  assert.throws(
    () => open(SECRET, sealed, { purpose: 'pix-key', aad: 'usuario-B' }),
    'copiar a linha do banco de outro jogador não deveria funcionar',
  );
});

test('chave derivada para outro propósito não decifra', () => {
  const sealed = seal(SECRET, 'valor', { purpose: 'pix-key' });
  assert.throws(() => open(SECRET, sealed, { purpose: 'outra-coisa' }));
});

test('segredo mestre diferente não decifra', () => {
  __resetKeyCache();
  const sealed = seal(SECRET, 'valor', { purpose: 'p' });
  __resetKeyCache();
  assert.throws(() => open('outro-segredo-mestre-igualmente-longo-0123456789', sealed, { purpose: 'p' }));
  __resetKeyCache();
});

test('entrada malformada é rejeitada sem vazar detalhe', () => {
  for (const bad of ['', 'x', 'v1.a.b', 'v2.a.b.c', 'v1....', null, 42]) {
    assert.throws(() => open(SECRET, bad, { purpose: 'p' }));
  }
});

test('segredo curto é recusado', () => {
  __resetKeyCache();
  assert.throws(() => seal('curto', 'valor', { purpose: 'p' }), /curto demais|ausente/);
  __resetKeyCache();
});
