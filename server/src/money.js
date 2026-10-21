/* Dinheiro.
 *
 * Tres regras que valem para todo este arquivo:
 *
 *  1. Tudo em CENTAVOS INTEIROS. Nunca float. `0.1 + 0.2 === 0.30000000000000004`
 *     e o codigo antigo calculava premio com `amount*2*0.8`.
 *  2. Toda movimentacao e uma transacao de partidas dobradas cujas pernas somam
 *     ZERO. Se nao somar, e bug, e a gravacao e abortada.
 *  3. Nada aqui confia no cliente. O valor da aposta, a comissao e o premio sao
 *     calculados aqui; o navegador so exibe.
 */
import { db } from './db.js';
import { randomUUID } from 'node:crypto';

export const userAccount   = (id)   => `user:${id}`;
export const escrowAccount = (code) => `escrow:${code}`;
export const HOUSE_RAKE    = 'house:rake';
export const EXTERNAL_PSP  = 'external:psp';

/** Saldo de uma conta, em centavos. */
export function balanceOf(account) {
  const row = db.prepare('SELECT balance_cents FROM balances WHERE account = ?').get(account);
  return row ? row.balance_cents : 0;
}

/**
 * Grava uma transacao no razao, de forma atomica.
 *
 * @param {object}  o
 * @param {string}  o.kind            deposit | withdrawal | stake | payout | rake | refund | adjustment
 * @param {Array}   o.entries         [{account, amount_cents}] — tem de somar zero
 * @param {string}  [o.idempotencyKey] repetir a mesma chave devolve a tx original
 * @param {boolean} [o.allowNegative] contas de sistema podem ficar negativas; carteira de jogador NAO
 */
export const postTransaction = db.transaction((o) => {
  const { kind, entries, idempotencyKey = null, memo = null, allowNegative = false } = o;

  if (!Array.isArray(entries) || entries.length < 2)
    throw new Error('transacao precisa de ao menos duas pernas');

  // Partida dobrada: a soma TEM de ser zero.
  const sum = entries.reduce((s, e) => s + e.amount_cents, 0);
  if (sum !== 0) throw new Error(`pernas nao somam zero (resultado: ${sum})`);

  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount_cents))
      throw new Error(`valor precisa ser inteiro em centavos: ${e.amount_cents}`);
    if (e.amount_cents === 0) throw new Error('perna com valor zero');
  }

  // Idempotencia: o gateway reenvia webhook, o usuario clica duas vezes, a rede
  // repete o POST. Com a mesma chave, o segundo pedido NAO cria outro lancamento.
  if (idempotencyKey) {
    const seen = db.prepare('SELECT id FROM ledger_tx WHERE idempotency_key = ?').get(idempotencyKey);
    if (seen) return { id: seen.id, duplicate: true };
  }

  const now = Date.now();
  const txId = randomUUID();
  db.prepare('INSERT INTO ledger_tx (id,kind,idempotency_key,memo,created_at) VALUES (?,?,?,?,?)')
    .run(txId, kind, idempotencyKey, memo, now);

  const insEntry = db.prepare(
    'INSERT INTO ledger_entry (tx_id,account,amount_cents,created_at) VALUES (?,?,?,?)');
  const upsertBal = db.prepare(`
    INSERT INTO balances (account, balance_cents, updated_at) VALUES (?,?,?)
    ON CONFLICT(account) DO UPDATE SET
      balance_cents = balance_cents + excluded.balance_cents,
      updated_at = excluded.updated_at`);

  for (const e of entries) {
    insEntry.run(txId, e.account, e.amount_cents, now);
    upsertBal.run(e.account, e.amount_cents, now);

    // Carteira de jogador nunca fica negativa. Esta checagem roda DENTRO da
    // transacao, depois da escrita: se estourar, o rollback desfaz tudo.
    // E isto que impede o saldo de virar numero inventado.
    if (!allowNegative && e.account.startsWith('user:')) {
      const after = db.prepare('SELECT balance_cents FROM balances WHERE account = ?').get(e.account);
      if (after.balance_cents < 0)
        throw Object.assign(new Error('saldo insuficiente'), { code: 'INSUFFICIENT_FUNDS' });
    }
  }
  return { id: txId, duplicate: false };
});

/** Confere se o razao esta integro. Rode periodicamente e apos incidente. */
export function auditIntegrity() {
  const unbalanced = db.prepare(`
    SELECT tx_id, SUM(amount_cents) AS total FROM ledger_entry
    GROUP BY tx_id HAVING total != 0`).all();

  const drifted = db.prepare(`
    SELECT b.account, b.balance_cents AS cache, COALESCE(SUM(e.amount_cents),0) AS real_sum
    FROM balances b LEFT JOIN ledger_entry e ON e.account = b.account
    GROUP BY b.account HAVING cache != real_sum`).all();

  // O dinheiro do mundo exterior entrou por external:psp; a soma de TODAS as
  // contas tem de ser zero, porque e partida dobrada.
  const grand = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM ledger_entry').get().t;

  return { ok: !unbalanced.length && !drifted.length && grand === 0, unbalanced, drifted, grandTotal: grand };
}

/** Extrato de um jogador, do mais recente para o mais antigo. */
export function statement(userId, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT e.id, e.amount_cents, e.created_at, t.kind, t.memo
    FROM ledger_entry e JOIN ledger_tx t ON t.id = e.tx_id
    WHERE e.account = ? ORDER BY e.id DESC LIMIT ? OFFSET ?`)
    .all(userAccount(userId), limit, offset);
}

/**
 * Divisao do pote com a comissao da casa, em inteiros.
 * O resto da divisao vai para a casa, nunca para o vencedor — assim a soma
 * fecha exatamente e nao sobra centavo orfao no escrow.
 */
export function splitPot(potCents, rakeBps) {
  if (!Number.isSafeInteger(potCents) || potCents < 0) throw new Error('pote invalido');
  const rake = Math.floor((potCents * rakeBps) / 10000);
  return { winnerCents: potCents - rake, rakeCents: rake };
}
