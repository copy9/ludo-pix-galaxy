/* Transacoes aninhadas.
 *
 * db.transaction() usa SAVEPOINT para aninhar, com um contador de profundidade
 * em variavel de modulo. Isso e exatamente o tipo de coisa que funciona nos
 * casos felizes e quebra no caminho de erro — e aqui quebrar significa gravar
 * metade de uma movimentacao de dinheiro.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-tx-'));
process.env.NODE_ENV = 'test';

const { db } = await import('../src/db.js');
const { postTransaction, balanceOf, userAccount, escrowAccount, EXTERNAL_PSP, auditIntegrity } =
  await import('../src/money.js');

const now = Date.now();
const mkUser = (id) => db.prepare(
  `INSERT INTO users (id,email,name,pass_hash,pass_salt,created_at,updated_at)
   VALUES (?,?,?,'x','y',?,?)`).run(id, `${id}@tx.com`, id, now, now);
const fund = (id, cents) => postTransaction({
  kind: 'deposit', idempotencyKey: `tx-seed:${id}`,
  entries: [{ account: EXTERNAL_PSP, amount_cents: -cents }, { account: userAccount(id), amount_cents: +cents }],
});

test('erro na transacao interna desfaz TUDO, inclusive a externa', () => {
  mkUser('aninha'); fund('aninha', 10000);

  const externa = db.transaction(() => {
    // Primeiro movimento: valido.
    postTransaction({
      kind: 'stake', idempotencyKey: 'nested-ok',
      entries: [
        { account: userAccount('aninha'), amount_cents: -3000 },
        { account: escrowAccount('NEST01'), amount_cents: +3000 },
      ],
    });
    // Segundo: estoura por saldo insuficiente.
    postTransaction({
      kind: 'stake', idempotencyKey: 'nested-fail',
      entries: [
        { account: userAccount('aninha'), amount_cents: -999999 },
        { account: escrowAccount('NEST01'), amount_cents: +999999 },
      ],
    });
  });

  assert.throws(() => externa(), (e) => e.code === 'INSUFFICIENT_FUNDS');

  // O PRIMEIRO movimento tambem tem de ter sido desfeito.
  assert.equal(balanceOf(userAccount('aninha')), 10000, 'saldo intacto');
  assert.equal(balanceOf(escrowAccount('NEST01')), 0, 'escrow nao pode ter sobrado');
  assert.ok(auditIntegrity().ok);
});

test('o contador de profundidade nao desincroniza depois de varios erros', () => {
  mkUser('ciclo'); fund('ciclo', 5000);

  // Dez transacoes que falham em sequencia. Se o contador desincronizar, a
  // proxima BEGIN estoura com "cannot start a transaction within a transaction".
  for (let i = 0; i < 10; i++) {
    assert.throws(() => db.transaction(() => {
      postTransaction({
        kind: 'stake',
        entries: [
          { account: userAccount('ciclo'), amount_cents: -999999 },
          { account: escrowAccount('X' + i), amount_cents: +999999 },
        ],
      });
    })());
  }

  // Depois de tudo isso, uma transacao valida ainda precisa funcionar.
  postTransaction({
    kind: 'stake', idempotencyKey: 'depois-dos-erros',
    entries: [
      { account: userAccount('ciclo'), amount_cents: -1000 },
      { account: escrowAccount('OK01'), amount_cents: +1000 },
    ],
  });
  assert.equal(balanceOf(userAccount('ciclo')), 4000);
  assert.ok(auditIntegrity().ok);
});

test('aninhamento de tres niveis desfaz corretamente a partir do mais fundo', () => {
  mkUser('fundo'); fund('fundo', 10000);
  const nivel3 = db.transaction(() => {
    postTransaction({
      kind: 'stake',
      entries: [
        { account: userAccount('fundo'), amount_cents: -99999 },
        { account: escrowAccount('D3'), amount_cents: +99999 },
      ],
    });
  });
  const nivel2 = db.transaction(() => {
    postTransaction({
      kind: 'stake', idempotencyKey: 'n2',
      entries: [
        { account: userAccount('fundo'), amount_cents: -1000 },
        { account: escrowAccount('D2'), amount_cents: +1000 },
      ],
    });
    nivel3();
  });
  const nivel1 = db.transaction(() => {
    postTransaction({
      kind: 'stake', idempotencyKey: 'n1',
      entries: [
        { account: userAccount('fundo'), amount_cents: -500 },
        { account: escrowAccount('D1'), amount_cents: +500 },
      ],
    });
    nivel2();
  });

  assert.throws(() => nivel1());
  assert.equal(balanceOf(userAccount('fundo')), 10000, 'nada pode ter saido');
  for (const e of ['D1', 'D2', 'D3']) assert.equal(balanceOf(escrowAccount(e)), 0, e);
  assert.ok(auditIntegrity().ok);
});

test('erro apos um aninhado BEM-SUCEDIDO ainda desfaz o aninhado', () => {
  mkUser('tardio'); fund('tardio', 8000);
  const t = db.transaction(() => {
    postTransaction({
      kind: 'stake', idempotencyKey: 'sucesso-interno',
      entries: [
        { account: userAccount('tardio'), amount_cents: -2000 },
        { account: escrowAccount('LATE'), amount_cents: +2000 },
      ],
    });
    throw new Error('falha depois do aninhado dar certo');
  });
  assert.throws(() => t(), /falha depois/);
  assert.equal(balanceOf(userAccount('tardio')), 8000);
  assert.equal(balanceOf(escrowAccount('LATE')), 0);

  /* E a chave de idempotencia tambem tem de ter sumido no rollback: se tivesse
     ficado gravada, a proxima tentativa legitima seria tratada como duplicada
     e o dinheiro nunca sairia da carteira. */
  postTransaction({
    kind: 'stake', idempotencyKey: 'sucesso-interno',
    entries: [
      { account: userAccount('tardio'), amount_cents: -2000 },
      { account: escrowAccount('LATE'), amount_cents: +2000 },
    ],
  });
  assert.equal(balanceOf(escrowAccount('LATE')), 2000, 'a repeticao precisa valer de verdade');
  assert.ok(auditIntegrity().ok);
});
