/**
 * Testes de integração do dinheiro, contra um PostgreSQL de verdade.
 *
 * Estes são os testes mais importantes do projeto. Cada um reproduz um ataque
 * ou um acidente que funcionava no protótipo e verifica que agora não funciona
 * mais — e, acima de tudo, que o caixa FECHA depois de cada operação.
 *
 * Exigem um banco: defina TEST_DATABASE_URL ou tenha postgres local com o
 * banco `ludo_test`. Sem banco, os testes são pulados em vez de falhar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PgLiteClient } from './helpers/pg-lite.js';
import * as ledger from '../src/modules/wallet/ledger.js';
import { splitPot } from '../src/lib/money.js';

const DB = { host: '127.0.0.1', port: 5432, user: 'ludo', database: 'ludo_test' };

let client = null;
let available = false;

try {
  client = new PgLiteClient(DB);
  await client.connect();
  await client.query('SELECT 1');
  available = true;
} catch (err) {
  console.error(`\n  [ledger-integration] banco indisponível (${err.message}); testes pulados.\n`);
}

const dbTest = (name, fn) => test(name, { skip: !available ? 'banco de teste indisponível' : false }, fn);

/** Zera o estado entre testes, mantendo as contas de sistema. */
async function reset() {
  await client.query('BEGIN');
  // O razão é append-only por trigger; desligamos só para limpar o teste.
  await client.query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_update');
  await client.query('ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_transactions_no_update');
  await client.query('DELETE FROM ledger_entries');
  await client.query('DELETE FROM ledger_transactions');
  await client.query('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_update');
  await client.query('ALTER TABLE ledger_transactions ENABLE TRIGGER ledger_transactions_no_update');
  await client.query(`DELETE FROM accounts WHERE kind = 'user_wallet'`);
  await client.query('DELETE FROM audit_log');
  await client.query('DELETE FROM users');
  await client.query('UPDATE accounts SET balance_cents = 0');
  await client.query('COMMIT');
}

async function makeUser(email) {
  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
    [email, email.split('@')[0]],
  );
  const userId = rows[0].id;
  await ledger.ensureUserAccount(client, userId);
  return userId;
}

/** Credita saldo como um depósito confirmado faria. */
async function deposit(userId, cents, key) {
  const wallet = await ledger.ensureUserAccount(client, userId);
  const gateway = await ledger.systemAccountId(client, 'pix_gateway');
  return ledger.transfer(client, {
    fromAccountId: gateway, toAccountId: wallet, amountCents: cents,
    reason: 'deposit', idempotencyKey: key,
  });
}

/** O caixa fechou? Soma de tudo = 0 e nenhum saldo divergente. */
async function assertBooksBalance() {
  const r = await ledger.reconcile(client);
  assert.equal(r.ledgerSum, 0, `o razão não soma zero: ${r.ledgerSum} centavos`);
  assert.deepEqual(r.driftingAccounts, [], 'há conta com saldo divergente do razão');
  assert.equal(r.ok, true);
}

/* ================================================================== */

dbTest('depósito credita a carteira e o caixa fecha', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  await deposit(user, 10_000, 'dep:1');
  assert.equal(await ledger.getBalance(client, user), 10_000);
  await assertBooksBalance();
});

dbTest('o mesmo depósito processado duas vezes credita uma vez só', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  const first = await deposit(user, 10_000, 'dep:mesma-chave');
  const second = await deposit(user, 10_000, 'dep:mesma-chave');

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true, 'a segunda vez deveria ser reconhecida como repetida');
  assert.equal(second.transactionId, first.transactionId);
  assert.equal(await ledger.getBalance(client, user), 10_000, 'webhook repetido não pode dobrar o saldo');
  await assertBooksBalance();
});

dbTest('não dá para gastar mais do que se tem', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  await deposit(user, 5_000, 'dep:2');

  const wallet = await ledger.ensureUserAccount(client, user);
  const escrow = await ledger.systemAccountId(client, 'escrow');

  await assert.rejects(
    () => ledger.transfer(client, {
      fromAccountId: wallet, toAccountId: escrow, amountCents: 5_001,
      reason: 'stake_hold', idempotencyKey: 'aposta:grande-demais',
    }),
    (err) => err.code === 'insufficient_funds',
  );

  assert.equal(await ledger.getBalance(client, user), 5_000, 'o saldo não pode ter mudado');
  await assertBooksBalance();
});

dbTest('lançamento que não soma zero é recusado — dinheiro não nasce', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  const wallet = await ledger.ensureUserAccount(client, user);
  const escrow = await ledger.systemAccountId(client, 'escrow');

  // Isto é o `addBalance(50)` do protótipo: crédito sem contrapartida.
  await assert.rejects(
    () => ledger.post(client, {
      reason: 'bonus_credit', idempotencyKey: 'dinheiro-do-nada',
      entries: [
        { accountId: wallet, amountCents: 5_000 },
        { accountId: escrow, amountCents: -1_000 }, // não fecha
      ],
    }),
    /desbalanceado/,
  );

  assert.equal(await ledger.getBalance(client, user), 0);
  await assertBooksBalance();
});

dbTest('o razão é append-only: UPDATE e DELETE são recusados pelo banco', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  await deposit(user, 1_000, 'dep:3');

  await assert.rejects(
    () => client.query('UPDATE ledger_entries SET amount_cents = 999999'),
    /append-only/,
  );
  await assert.rejects(() => client.query('DELETE FROM ledger_entries'), /append-only/);
  assert.equal(await ledger.getBalance(client, user), 1_000);
});

dbTest('fluxo completo de desafio: aposta, prêmio 80/20 e caixa fechado', async () => {
  await reset();
  const alice = await makeUser('alice@teste.com');
  const bob = await makeUser('bob@teste.com');
  await deposit(alice, 10_000, 'dep:alice');
  await deposit(bob, 10_000, 'dep:bob');

  const stake = 5_000;
  const aliceWallet = await ledger.ensureUserAccount(client, alice);
  const bobWallet = await ledger.ensureUserAccount(client, bob);
  const escrow = await ledger.systemAccountId(client, 'escrow');
  const house = await ledger.systemAccountId(client, 'house_revenue');

  // Os dois travam a aposta.
  await ledger.transfer(client, {
    fromAccountId: aliceWallet, toAccountId: escrow, amountCents: stake,
    reason: 'stake_hold', idempotencyKey: 'stake:d1:creator',
  });
  await ledger.transfer(client, {
    fromAccountId: bobWallet, toAccountId: escrow, amountCents: stake,
    reason: 'stake_hold', idempotencyKey: 'stake:d1:opponent',
  });

  assert.equal(await ledger.getBalance(client, alice), 5_000);
  assert.equal(await ledger.getBalance(client, bob), 5_000);
  await assertBooksBalance();

  // Alice vence. Pote 10.000; prêmio 8.000; comissão 2.000.
  const pot = stake * 2;
  const { prizeCents, commissionCents } = splitPot(pot, 2000);
  assert.equal(prizeCents, 8_000);
  assert.equal(commissionCents, 2_000);

  await ledger.post(client, {
    reason: 'prize_payout', idempotencyKey: 'payout:d1',
    entries: [
      { accountId: escrow, amountCents: -pot },
      { accountId: aliceWallet, amountCents: prizeCents },
      { accountId: house, amountCents: commissionCents },
    ],
  });

  assert.equal(await ledger.getBalance(client, alice), 13_000, 'tinha 5.000, ganhou 8.000');
  assert.equal(await ledger.getBalance(client, bob), 5_000, 'perdeu a aposta');

  const { rows: houseRows } = await client.query(
    `SELECT balance_cents FROM accounts WHERE system_key = 'house_revenue'`,
  );
  assert.equal(houseRows[0].balance_cents, 2_000);

  const { rows: escrowRows } = await client.query(
    `SELECT balance_cents FROM accounts WHERE system_key = 'escrow'`,
  );
  assert.equal(escrowRows[0].balance_cents, 0, 'o escrow precisa esvaziar ao liquidar');

  await assertBooksBalance();
});

dbTest('pagar o mesmo prêmio duas vezes não paga duas vezes', async () => {
  await reset();
  const alice = await makeUser('alice@teste.com');
  await deposit(alice, 5_000, 'dep:alice');
  const wallet = await ledger.ensureUserAccount(client, alice);
  const escrow = await ledger.systemAccountId(client, 'escrow');

  await ledger.transfer(client, {
    fromAccountId: wallet, toAccountId: escrow, amountCents: 5_000,
    reason: 'stake_hold', idempotencyKey: 'stake:d2:creator',
  });

  const pay = () => ledger.transfer(client, {
    fromAccountId: escrow, toAccountId: wallet, amountCents: 5_000,
    reason: 'prize_payout', idempotencyKey: 'payout:d2',
  });

  await pay();
  const second = await pay();
  assert.equal(second.replayed, true);
  assert.equal(await ledger.getBalance(client, alice), 5_000);
  await assertBooksBalance();
});

dbTest('devolução de aposta repõe exatamente o que foi travado', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  await deposit(user, 3_000, 'dep:x');
  const wallet = await ledger.ensureUserAccount(client, user);
  const escrow = await ledger.systemAccountId(client, 'escrow');

  await ledger.transfer(client, {
    fromAccountId: wallet, toAccountId: escrow, amountCents: 3_000,
    reason: 'stake_hold', idempotencyKey: 'stake:d3:creator',
  });
  assert.equal(await ledger.getBalance(client, user), 0);

  await ledger.transfer(client, {
    fromAccountId: escrow, toAccountId: wallet, amountCents: 3_000,
    reason: 'stake_refund', idempotencyKey: 'stake-refund:d3:creator',
  });
  assert.equal(await ledger.getBalance(client, user), 3_000);
  await assertBooksBalance();
});

dbTest('o extrato mostra o histórico com saldo após cada lançamento', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  await deposit(user, 10_000, 'dep:e1');
  const wallet = await ledger.ensureUserAccount(client, user);
  const escrow = await ledger.systemAccountId(client, 'escrow');
  await ledger.transfer(client, {
    fromAccountId: wallet, toAccountId: escrow, amountCents: 2_500,
    reason: 'stake_hold', idempotencyKey: 'stake:e1:creator',
  });

  const rows = await ledger.statement(client, user);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount_cents, -2_500, 'mais recente primeiro');
  assert.equal(rows[0].balance_after, 7_500);
  assert.equal(rows[1].amount_cents, 10_000);
  assert.equal(rows[1].balance_after, 10_000);
});

dbTest('a conciliação denuncia um saldo adulterado por fora do razão', async () => {
  await reset();
  const user = await makeUser('a@teste.com');
  await deposit(user, 1_000, 'dep:z');
  await assertBooksBalance();

  // Simula alguém com acesso ao banco "ajustando" o saldo direto.
  const wallet = await ledger.ensureUserAccount(client, user);
  await client.query(`UPDATE accounts SET balance_cents = 999999 WHERE id = $1`, [wallet]);

  const r = await ledger.reconcile(client);
  assert.equal(r.ok, false, 'a conciliação precisa detectar a adulteração');
  assert.equal(r.driftingAccounts.length, 1);
  assert.equal(r.driftingAccounts[0].cached, 999999);
  assert.equal(r.driftingAccounts[0].computed, 1000);
});

test('encerra a conexão de teste', { skip: !available }, async () => {
  await reset();
  await client.end();
});
