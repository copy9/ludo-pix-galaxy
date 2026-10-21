/**
 * Saques.
 *
 * O caminho por onde o dinheiro SAI é o mais sensível do sistema inteiro, e
 * o único que nunca deve ser automático no começo da operação.
 *
 * Fluxo:
 *   1. O jogador pede o saque. O valor sai da carteira NA HORA e vai para a
 *      conta de escrow (`withdrawal_hold`). Isso impede o clássico: pedir
 *      três saques do saldo total antes de o primeiro ser pago.
 *   2. O pedido entra numa fila de revisão humana.
 *   3. Aprovado, o Pix é enviado e o lançamento vira `withdrawal_paid`.
 *   4. Recusado, o valor volta para a carteira (`withdrawal_refund`).
 *
 * Exigências antes de permitir o pedido:
 *   • conta verificada (KYC nível 3) — é requisito regulatório e a principal
 *     barreira contra lavagem via depósito-e-saque;
 *   • chave Pix do próprio titular;
 *   • senha reconfirmada, para que uma sessão roubada não esvazie a conta.
 */

import { config } from '../../config.js';
import { withTransaction, withRetryableTransaction } from '../../db/pool.js';
import { badRequest, notFound, conflict, kycRequired, forbidden } from '../../lib/errors.js';
import { requirePositiveCents, formatBRL } from '../../lib/money.js';
import { normalizePixKey } from '../../lib/validate.js';
import { verifyPassword, blindIndex } from '../../lib/passwords.js';
import { seal, open as unseal } from '../../lib/crypto-box.js';
import * as ledger from '../wallet/ledger.js';
import { PAYOUT_STATUS } from './provider.js';

export async function requestWithdrawal({ userId, amountInput, pixKeyType, pixKey, password }) {
  const amountCents = requirePositiveCents(amountInput, {
    min: config.MIN_WITHDRAWAL_CENTS,
    max: 1_000_000_00,
    label: 'saque',
  });

  const { normalized, masked } = normalizePixKey(pixKeyType, pixKey);

  return withRetryableTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, password_hash, kyc_level, doc_status, is_frozen, full_name, cpf_hash
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const user = rows[0];
    if (!user) throw notFound('Usuário não encontrado.');
    if (user.is_frozen) throw forbidden('Conta bloqueada. Fale com o suporte.');

    // KYC: sem isso não há saque. Note que a autoexclusão NÃO bloqueia saque —
    // quem se autoexcluiu precisa poder retirar o próprio dinheiro.
    if (user.kyc_level !== 'verified') {
      throw kycRequired('Para sacar é preciso ter a conta verificada: dados completos e documento aprovado.');
    }

    // Reconfirmação de senha: uma sessão roubada não basta para sacar.
    if (!(await verifyPassword(password ?? '', user.password_hash))) {
      await client.query(
        `INSERT INTO audit_log (actor_id, action, target_type, detail)
         VALUES ($1, 'withdrawal.bad_password', 'user', $2)`,
        [userId, JSON.stringify({ amountCents })],
      );
      throw forbidden('Senha incorreta.');
    }

    // A chave Pix precisa ser do titular. Para chave do tipo CPF isso é
    // verificável na hora: tem que bater com o CPF da conta verificada.
    if (pixKeyType === 'cpf') {
      const keyHash = blindIndex(config.SESSION_SECRET, normalized);
      if (user.cpf_hash && keyHash !== user.cpf_hash) {
        throw badRequest('A chave Pix precisa ser o CPF do titular da conta.');
      }
    }

    // Um saque pendente por vez: simplifica a revisão e fecha a janela de
    // pedir vários em paralelo.
    const { rows: openRows } = await client.query(
      `SELECT count(*)::int AS n FROM withdrawals
        WHERE user_id = $1 AND status IN ('pending_review', 'approved')`,
      [userId],
    );
    if (openRows[0].n > 0) {
      throw conflict('Você já tem um saque em análise. Aguarde a conclusão.');
    }

    const balance = await ledger.getBalance(client, userId);
    if (balance < amountCents) {
      throw badRequest(`Saldo insuficiente. Disponível: ${formatBRL(balance)}.`);
    }

    const { rows: created } = await client.query(
      `INSERT INTO withdrawals (user_id, amount_cents, pix_key_type, pix_key_hash,
                                pix_key_masked, pix_key_sealed, provider, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review')
       RETURNING id, amount_cents, status, created_at`,
      [
        userId, amountCents, pixKeyType,
        blindIndex(config.SESSION_SECRET, normalized),
        masked,
        // Cifrada, não em hash: o pagamento precisa da chave real de volta.
        // O `aad` amarra ao usuário — um texto cifrado copiado de outra linha
        // do banco não decifra aqui.
        seal(config.SESSION_SECRET, normalized, { purpose: 'pix-key', aad: userId }),
        config.PAYMENT_PROVIDER,
      ],
    );
    const withdrawal = created[0];

    // O dinheiro sai da carteira AGORA e fica retido no escrow.
    const walletId = await ledger.ensureUserAccount(client, userId);
    const escrowId = await ledger.systemAccountId(client, 'escrow');
    const { transactionId } = await ledger.transfer(client, {
      fromAccountId: walletId,
      toAccountId: escrowId,
      amountCents,
      reason: 'withdrawal_hold',
      idempotencyKey: `withdrawal-hold:${withdrawal.id}`,
      referenceType: 'withdrawal',
      referenceId: withdrawal.id,
      memo: 'Saque solicitado — valor retido para análise',
    });

    await client.query(`UPDATE withdrawals SET hold_tx_id = $2 WHERE id = $1`, [withdrawal.id, transactionId]);
    await client.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
       VALUES ($1, 'withdrawal.requested', 'withdrawal', $2, $3)`,
      [userId, withdrawal.id, JSON.stringify({ amountCents, pixKeyMasked: masked })],
    );

    return {
      id: withdrawal.id,
      amountCents,
      status: 'pending_review',
      pixKeyMasked: masked,
      createdAt: withdrawal.created_at,
    };
  });
}

/** Aprova e envia o Pix. Só administrador. */
export async function approveWithdrawal({ provider, withdrawalId, adminId }) {
  const prepared = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT w.*, u.full_name FROM withdrawals w JOIN users u ON u.id = w.user_id
        WHERE w.id = $1 FOR UPDATE OF w`,
      [withdrawalId],
    );
    const w = rows[0];
    if (!w) throw notFound('Saque não encontrado.');
    if (w.status !== 'pending_review') throw conflict(`Saque já está em ${w.status}.`);

    await client.query(
      `UPDATE withdrawals SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
        WHERE id = $1`,
      [withdrawalId, adminId],
    );
    return w;
  });

  // Chamada externa fora da transação.
  let payout;
  try {
    payout = await provider.sendPixPayout({
      withdrawalId: prepared.id,
      amountCents: prepared.amount_cents,
      // Decifrada só aqui, no instante do pagamento, e nunca registrada em log.
      pixKey: unseal(config.SESSION_SECRET, prepared.pix_key_sealed, {
        purpose: 'pix-key',
        aad: prepared.user_id,
      }),
      pixKeyType: prepared.pix_key_type,
      recipientName: prepared.full_name,
    });
  } catch (err) {
    await withTransaction((client) =>
      client.query(
        `UPDATE withdrawals SET status = 'pending_review', reviewed_by = NULL, reviewed_at = NULL,
                                updated_at = now() WHERE id = $1`,
        [withdrawalId],
      ),
    );
    throw err;
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE withdrawals SET provider_payout_id = $2, status = $3, updated_at = now() WHERE id = $1`,
      [withdrawalId, payout.providerPayoutId, payout.status === PAYOUT_STATUS.PAID ? 'paid' : 'approved'],
    );
    if (payout.status === PAYOUT_STATUS.PAID) await settlePaid(client, withdrawalId);
    await client.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
       VALUES ($1, 'withdrawal.approved', 'withdrawal', $2, $3)`,
      [adminId, withdrawalId, JSON.stringify({ amountCents: prepared.amount_cents })],
    );
  });

  return { id: withdrawalId, status: payout.status };
}

/** Baixa contábil do saque pago: o valor sai do escrow para o mundo externo. */
export async function settlePaid(client, withdrawalId) {
  const { rows } = await client.query(
    `SELECT id, amount_cents, settle_tx_id FROM withdrawals WHERE id = $1 FOR UPDATE`,
    [withdrawalId],
  );
  const w = rows[0];
  if (!w) throw notFound('Saque não encontrado.');
  if (w.settle_tx_id) return { alreadyProcessed: true };

  const escrowId = await ledger.systemAccountId(client, 'escrow');
  const gatewayId = await ledger.systemAccountId(client, 'pix_gateway');
  const { transactionId } = await ledger.transfer(client, {
    fromAccountId: escrowId,
    toAccountId: gatewayId,
    amountCents: w.amount_cents,
    reason: 'withdrawal_paid',
    idempotencyKey: `withdrawal-paid:${w.id}`,
    referenceType: 'withdrawal',
    referenceId: w.id,
    memo: 'Saque pago via Pix',
  });
  await client.query(
    `UPDATE withdrawals SET status = 'paid', settle_tx_id = $2, updated_at = now() WHERE id = $1`,
    [w.id, transactionId],
  );
  return { alreadyProcessed: false };
}

/** Recusa o saque e devolve o valor à carteira do jogador. */
export async function rejectWithdrawal({ withdrawalId, adminId, reason }) {
  if (!reason || reason.trim().length < 5) {
    throw badRequest('Informe o motivo da recusa — ele vai para o histórico do jogador.');
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`,
      [withdrawalId],
    );
    const w = rows[0];
    if (!w) throw notFound('Saque não encontrado.');
    if (!['pending_review', 'approved'].includes(w.status)) {
      throw conflict(`Saque em ${w.status} não pode ser recusado.`);
    }

    const walletId = await ledger.ensureUserAccount(client, w.user_id);
    const escrowId = await ledger.systemAccountId(client, 'escrow');
    await ledger.transfer(client, {
      fromAccountId: escrowId,
      toAccountId: walletId,
      amountCents: w.amount_cents,
      reason: 'withdrawal_refund',
      idempotencyKey: `withdrawal-refund:${w.id}`,
      referenceType: 'withdrawal',
      referenceId: w.id,
      memo: `Saque recusado: ${reason.slice(0, 180)}`,
    });

    await client.query(
      `UPDATE withdrawals SET status = 'rejected', reject_reason = $2, reviewed_by = $3,
                              reviewed_at = now(), updated_at = now() WHERE id = $1`,
      [withdrawalId, reason.slice(0, 500), adminId],
    );
    await client.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
       VALUES ($1, 'withdrawal.rejected', 'withdrawal', $2, $3)`,
      [adminId, withdrawalId, JSON.stringify({ reason })],
    );
    return { id: withdrawalId, status: 'rejected' };
  });
}

export async function listWithdrawals(client, userId, limit = 20) {
  const { rows } = await client.query(
    `SELECT id, amount_cents, status, pix_key_masked, reject_reason, created_at, reviewed_at
       FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 100)],
  );
  return rows;
}

export async function reviewQueue(client, limit = 50) {
  const { rows } = await client.query(
    `SELECT w.id, w.amount_cents, w.pix_key_type, w.pix_key_masked, w.created_at,
            u.id AS user_id, u.email, u.full_name, u.kyc_level,
            (SELECT COALESCE(SUM(d.amount_cents), 0)::bigint FROM deposits d
              WHERE d.user_id = u.id AND d.status = 'paid') AS lifetime_deposits
       FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.status = 'pending_review'
      ORDER BY w.created_at ASC LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return rows;
}
