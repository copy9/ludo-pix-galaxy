/**
 * Livro-razão de partidas dobradas.
 *
 * Esta é a única porta por onde dinheiro se move. Nenhum outro módulo escreve
 * em `accounts.balance_cents` nem em `ledger_entries` diretamente.
 *
 * Três garantias, nesta ordem de importância:
 *
 *  1. CONSERVAÇÃO. Toda transação é uma lista de lançamentos que soma zero.
 *     Dinheiro sai de uma conta e entra em outra. Não existe "creditar" sem
 *     dizer de onde veio — era exatamente o que o `addBalance(50)` do
 *     protótipo fazia, e por isso qualquer um imprimia saldo pelo console.
 *
 *  2. IDEMPOTÊNCIA. Toda transação carrega uma chave única. Webhook repetido,
 *     clique duplo e retry de rede produzem a MESMA transação, não duas.
 *
 *  3. TRAVA DE LINHA. Antes de debitar, a conta é travada com SELECT ... FOR
 *     UPDATE. Duas apostas simultâneas do mesmo jogador não conseguem gastar
 *     o mesmo saldo duas vezes — o segundo pedido espera e então falha por
 *     saldo insuficiente, como deve.
 */

import { insufficientFunds, AppError } from '../../lib/errors.js';

/** Garante que o usuário tem carteira e devolve o id da conta. */
export async function ensureUserAccount(client, userId) {
  const { rows } = await client.query(
    `INSERT INTO accounts (kind, user_id) VALUES ('user_wallet', $1)
       ON CONFLICT (user_id) WHERE kind = 'user_wallet' DO NOTHING
     RETURNING id`,
    [userId],
  );
  if (rows[0]) return rows[0].id;
  const existing = await client.query(
    `SELECT id FROM accounts WHERE user_id = $1 AND kind = 'user_wallet'`,
    [userId],
  );
  return existing.rows[0].id;
}

export async function systemAccountId(client, key) {
  const { rows } = await client.query(`SELECT id FROM accounts WHERE system_key = $1`, [key]);
  if (!rows[0]) throw new Error(`Conta de sistema ausente: ${key}. Rode as migrações.`);
  return rows[0].id;
}

/** Saldo da carteira do usuário, em centavos. */
export async function getBalance(client, userId) {
  const { rows } = await client.query(
    `SELECT balance_cents FROM accounts WHERE user_id = $1 AND kind = 'user_wallet'`,
    [userId],
  );
  return rows[0]?.balance_cents ?? 0;
}

/**
 * Trava as contas envolvidas em ordem determinística (por id) e devolve os
 * saldos atuais. Ordenar é o que evita deadlock quando duas transações mexem
 * nas mesmas contas em sentidos opostos.
 */
async function lockAccounts(client, accountIds) {
  const unique = [...new Set(accountIds)].sort();
  const { rows } = await client.query(
    `SELECT id, kind, balance_cents FROM accounts WHERE id = ANY($1::uuid[])
       ORDER BY id FOR UPDATE`,
    [unique],
  );
  if (rows.length !== unique.length) throw new Error('Conta inexistente em um lançamento.');
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Registra uma transação no razão.
 *
 * @param {object} client     cliente pg DENTRO de uma transação
 * @param {object} opts
 * @param {string} opts.reason           valor do enum ledger_reason
 * @param {string} opts.idempotencyKey   chave única; repetir devolve a original
 * @param {Array}  opts.entries          [{ accountId, amountCents }], soma zero
 * @param {string} [opts.memo]
 * @returns {{ transactionId, replayed, balances }}
 */
export async function post(client, { reason, idempotencyKey, entries, memo, referenceType, referenceId, createdBy }) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error('Um lançamento precisa de ao menos duas pernas.');
  }
  const sum = entries.reduce((s, e) => s + e.amountCents, 0);
  if (sum !== 0) {
    // Esta é a trava contábil em código, além da que existe no banco.
    throw new Error(`Lançamento desbalanceado: soma ${sum} centavos, deveria ser 0.`);
  }
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amountCents) || e.amountCents === 0) {
      throw new Error('Valor de lançamento inválido.');
    }
  }

  // Idempotência: se a chave já existe, devolvemos a transação original sem
  // reaplicar nada. É o que torna seguro o provedor reenviar um webhook.
  const existing = await client.query(
    `SELECT id FROM ledger_transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  if (existing.rows[0]) {
    return { transactionId: existing.rows[0].id, replayed: true, balances: new Map() };
  }

  const locked = await lockAccounts(client, entries.map((e) => e.accountId));

  // Agrega por conta: a mesma conta pode aparecer duas vezes num lançamento.
  const deltas = new Map();
  for (const e of entries) {
    deltas.set(e.accountId, (deltas.get(e.accountId) || 0) + e.amountCents);
  }

  // Confere saldo ANTES de escrever, para devolver um erro limpo em vez de
  // deixar a constraint do banco estourar com mensagem técnica.
  for (const [accountId, delta] of deltas) {
    const acct = locked.get(accountId);
    if (acct.kind === 'user_wallet' && acct.balance_cents + delta < 0) {
      throw insufficientFunds();
    }
  }

  const tx = await client.query(
    `INSERT INTO ledger_transactions (reason, idempotency_key, memo, reference_type, reference_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [reason, idempotencyKey, memo ?? null, referenceType ?? null, referenceId ?? null, createdBy ?? null],
  );
  const transactionId = tx.rows[0].id;

  const balances = new Map();
  for (const [accountId, delta] of [...deltas].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const updated = await client.query(
      `UPDATE accounts SET balance_cents = balance_cents + $2 WHERE id = $1
       RETURNING balance_cents`,
      [accountId, delta],
    );
    const balanceAfter = updated.rows[0].balance_cents;
    balances.set(accountId, balanceAfter);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount_cents, balance_after)
       VALUES ($1, $2, $3, $4)`,
      [transactionId, accountId, delta, balanceAfter],
    );
  }

  // Cinto e suspensório: confirma no banco que a transação fechou em zero.
  await client.query('SELECT assert_transaction_balanced($1)', [transactionId]);

  return { transactionId, replayed: false, balances };
}

/**
 * Move dinheiro entre duas contas. Açúcar sobre `post` para o caso comum.
 */
export async function transfer(client, { fromAccountId, toAccountId, amountCents, ...rest }) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new AppError('Valor de transferência inválido.', { statusCode: 400 });
  }
  if (fromAccountId === toAccountId) {
    throw new Error('Origem e destino iguais.');
  }
  return post(client, {
    ...rest,
    entries: [
      { accountId: fromAccountId, amountCents: -amountCents },
      { accountId: toAccountId, amountCents },
    ],
  });
}

/** Extrato da carteira do usuário, mais recente primeiro. */
export async function statement(client, userId, { limit = 50, before } = {}) {
  const { rows } = await client.query(
    `SELECT e.id, e.amount_cents, e.balance_after, e.created_at,
            t.reason, t.memo, t.reference_type, t.reference_id
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN accounts a ON a.id = e.account_id
      WHERE a.user_id = $1 AND a.kind = 'user_wallet'
        AND ($2::bigint IS NULL OR e.id < $2)
      ORDER BY e.id DESC
      LIMIT $3`,
    [userId, before ?? null, Math.min(limit, 200)],
  );
  return rows;
}

/**
 * Conferência de caixa: a soma de TODAS as contas tem que ser zero, e o cache
 * `balance_cents` tem que bater com a soma dos lançamentos de cada conta.
 *
 * Rode isso periodicamente em produção. Se um dia não fechar, você descobre
 * pelo alarme — não por um jogador reclamando.
 */
export async function reconcile(client) {
  const { rows: totals } = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries`,
  );
  const { rows: drift } = await client.query(
    `SELECT a.id, a.kind, a.system_key, a.user_id,
            a.balance_cents AS cached,
            COALESCE(SUM(e.amount_cents), 0) AS computed
       FROM accounts a
       LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id
     HAVING a.balance_cents <> COALESCE(SUM(e.amount_cents), 0)`,
  );
  return {
    balanced: Number(totals[0].total) === 0,
    ledgerSum: Number(totals[0].total),
    driftingAccounts: drift,
    ok: Number(totals[0].total) === 0 && drift.length === 0,
  };
}
