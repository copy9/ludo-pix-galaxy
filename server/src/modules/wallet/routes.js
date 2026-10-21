/**
 * Rotas da carteira.
 *
 * Só leitura. Não existe nenhuma rota que o jogador possa chamar para mudar
 * o próprio saldo — o saldo só se move por depósito confirmado, aposta,
 * prêmio ou saque, e todas essas transições vivem nos módulos próprios.
 */

import { withTransaction } from '../../db/pool.js';
import { v, validate } from '../../lib/validate.js';
import * as ledger from './ledger.js';

const REASON_LABEL = {
  deposit: { icon: '💠', label: 'Depósito via Pix' },
  withdrawal_hold: { icon: '⬇️', label: 'Saque solicitado' },
  withdrawal_paid: { icon: '✅', label: 'Saque pago' },
  withdrawal_refund: { icon: '↩️', label: 'Saque devolvido' },
  stake_hold: { icon: '🎲', label: 'Aposta em desafio' },
  stake_refund: { icon: '↩️', label: 'Aposta devolvida' },
  prize_payout: { icon: '🏆', label: 'Prêmio de desafio' },
  house_commission: { icon: '🏛️', label: 'Comissão' },
  bonus_credit: { icon: '🎁', label: 'Bônus' },
  manual_adjustment: { icon: '🔧', label: 'Ajuste' },
};

export function registerWalletRoutes(router) {
  router.get('/api/wallet/balance', async (ctx) => {
    const user = ctx.requireAuth();
    const balanceCents = await withTransaction((client) => ledger.getBalance(client, user.user_id));
    return { balanceCents };
  });

  router.get('/api/wallet/statement', async (ctx) => {
    const user = ctx.requireAuth();
    const { before } = validate(ctx.query, {
      before: v.optional(v.int({ min: 1 })),
    });

    const rows = await withTransaction((client) =>
      ledger.statement(client, user.user_id, { limit: 50, before }),
    );

    return {
      entries: rows.map((r) => ({
        id: r.id,
        amountCents: r.amount_cents,
        balanceAfterCents: r.balance_after,
        direction: r.amount_cents > 0 ? 'in' : 'out',
        reason: r.reason,
        icon: REASON_LABEL[r.reason]?.icon ?? '•',
        label: REASON_LABEL[r.reason]?.label ?? r.reason,
        memo: r.memo,
        createdAt: r.created_at,
      })),
      nextBefore: rows.length ? rows[rows.length - 1].id : null,
    };
  });
}
