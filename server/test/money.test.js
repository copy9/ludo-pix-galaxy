import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmountToCents,
  requirePositiveCents,
  formatBRL,
  splitPot,
  MoneyError,
} from '../src/lib/money.js';

test('aceita vírgula, ponto e inteiro', () => {
  assert.equal(parseAmountToCents('10'), 1000);
  assert.equal(parseAmountToCents('10,50'), 1050);
  assert.equal(parseAmountToCents('10.50'), 1050);
  assert.equal(parseAmountToCents('R$ 10,50'), 1050);
  assert.equal(parseAmountToCents('0,01'), 1);
  assert.equal(parseAmountToCents('10,5'), 1050);
});

test('rejeita lixo em vez de arredondar em silêncio', () => {
  for (const bad of ['', 'abc', '10,555', '1.234,56', '1e3', '10..5', null, undefined, {}, NaN, Infinity]) {
    assert.throws(() => parseAmountToCents(bad), MoneyError, `deveria rejeitar ${JSON.stringify(bad)}`);
  }
});

test('o erro clássico do ponto flutuante não acontece', () => {
  const a = parseAmountToCents('0,10');
  const b = parseAmountToCents('0,20');
  assert.equal(a + b, 30, 'em centavos inteiros, 0,10 + 0,20 é exatamente 0,30');
  assert.notEqual(0.1 + 0.2, 0.3, 'em float, não é — por isso não usamos float');
});

test('faixas mínima e máxima são aplicadas', () => {
  assert.equal(requirePositiveCents('10', { min: 500, max: 500000 }), 1000);
  assert.throws(() => requirePositiveCents('1', { min: 500 }), MoneyError);
  assert.throws(() => requirePositiveCents('99999', { max: 500000 }), MoneyError);
});

test('formata como moeda brasileira', () => {
  assert.equal(formatBRL(0), 'R$ 0,00');
  assert.equal(formatBRL(1), 'R$ 0,01');
  assert.equal(formatBRL(1050), 'R$ 10,50');
  assert.equal(formatBRL(123456789), 'R$ 1.234.567,89');
  assert.equal(formatBRL(-500), '-R$ 5,00');
});

test('a divisão do pote fecha exatamente, sem centavo perdido', () => {
  for (let pot = 0; pot <= 3000; pot += 1) {
    const { prizeCents, commissionCents } = splitPot(pot, 2000);
    assert.equal(prizeCents + commissionCents, pot, `pote ${pot} não fechou`);
    assert.ok(prizeCents >= 0 && commissionCents >= 0);
  }
});

test('o centavo da divisão inexata fica com o jogador, não com a casa', () => {
  // Pote de R$ 0,03 com 20%: 0,006 de comissão. Arredondando para baixo,
  // a casa fica com 0 e o jogador leva os 3 centavos.
  const { prizeCents, commissionCents } = splitPot(3, 2000);
  assert.equal(commissionCents, 0);
  assert.equal(prizeCents, 3);
});

test('a divisão de 80/20 bate com o esperado em valores redondos', () => {
  const { prizeCents, commissionCents } = splitPot(20000, 2000); // pote R$ 200
  assert.equal(prizeCents, 16000);
  assert.equal(commissionCents, 4000);
});

test('comissão fora da faixa é rejeitada', () => {
  assert.throws(() => splitPot(1000, -1), MoneyError);
  assert.throws(() => splitPot(1000, 6000), MoneyError, 'teto de 50% protege o jogador');
  assert.throws(() => splitPot(-1, 2000), MoneyError);
});
