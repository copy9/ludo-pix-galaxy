/**
 * Jogo responsável.
 *
 * No protótipo os limites viviam no `localStorage` — ou seja, o próprio
 * jogador podia apagar o limite que tinha acabado de pôr. Isso inverte o
 * propósito da funcionalidade: quem precisa de limite é exatamente quem, num
 * momento ruim, vai querer removê-lo.
 *
 * Aqui:
 *   • o limite mora no servidor;
 *   • APERTAR um limite vale imediatamente;
 *   • AFROUXAR passa por carência de 24 horas;
 *   • a autoexclusão NÃO tem volta antes do prazo, nem por pedido ao suporte,
 *     e durante ela o jogador consegue sacar o saldo mas não apostar.
 *
 * Esta assimetria é o padrão da regulação de jogo em vários países e é o
 * mínimo defensável para um produto que lida com dinheiro.
 */

import { selfExcluded, badRequest } from '../../lib/errors.js';
import { formatBRL } from '../../lib/money.js';

export const COOLDOWN_MS = 24 * 3_600_000;

const WINDOWS = [
  { field: 'deposit_limit_day', interval: '1 day', label: 'diário' },
  { field: 'deposit_limit_week', interval: '7 days', label: 'semanal' },
  { field: 'deposit_limit_month', interval: '30 days', label: 'mensal' },
];

export async function getSettings(client, userId) {
  const { rows } = await client.query(
    `SELECT * FROM responsible_gaming WHERE user_id = $1`,
    [userId],
  );
  if (rows[0]) return applyPendingIfDue(rows[0]);
  const { rows: created } = await client.query(
    `INSERT INTO responsible_gaming (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId],
  );
  return created[0];
}

/** Se a carência já venceu, os limites pendentes passam a valer. */
function applyPendingIfDue(row) {
  if (!row.pending_limits || !row.pending_effective_at) return row;
  if (new Date(row.pending_effective_at) > new Date()) return row;
  return { ...row, ...row.pending_limits, pending_limits: null, pending_effective_at: null };
}

/** Materializa no banco os limites pendentes já vencidos. */
export async function flushPendingLimits(client) {
  const { rowCount } = await client.query(
    `UPDATE responsible_gaming
        SET deposit_limit_day   = COALESCE((pending_limits->>'deposit_limit_day')::bigint,   deposit_limit_day),
            deposit_limit_week  = COALESCE((pending_limits->>'deposit_limit_week')::bigint,  deposit_limit_week),
            deposit_limit_month = COALESCE((pending_limits->>'deposit_limit_month')::bigint, deposit_limit_month),
            stake_limit_day     = COALESCE((pending_limits->>'stake_limit_day')::bigint,     stake_limit_day),
            pending_limits = NULL, pending_effective_at = NULL, updated_at = now()
      WHERE pending_limits IS NOT NULL AND pending_effective_at <= now()`,
  );
  return rowCount;
}

/**
 * Atualiza limites. Devolve quais valeram na hora e quais ficaram em carência.
 * Um limite MENOR (mais restritivo) é sempre imediato; MAIOR ou removido espera.
 */
export async function updateLimits(client, userId, requested) {
  const current = await getSettings(client, userId);

  const immediate = {};
  const deferred = {};

  for (const field of ['deposit_limit_day', 'deposit_limit_week', 'deposit_limit_month', 'stake_limit_day']) {
    if (!(field in requested)) continue;
    const next = requested[field];
    const now = current[field];

    if (next !== null && (!Number.isSafeInteger(next) || next <= 0)) {
      throw badRequest('O limite precisa ser um valor positivo.');
    }
    // Sem limite antes, qualquer limite agora é mais restritivo: imediato.
    if (now === null || now === undefined) {
      if (next === null) continue;
      immediate[field] = next;
      continue;
    }
    // Remover o limite é sempre afrouxar.
    if (next === null) { deferred[field] = null; continue; }
    if (next <= now) immediate[field] = next;
    else deferred[field] = next;
  }

  // Coerência: o limite diário não pode passar do semanal, nem o semanal do mensal.
  const merged = { ...current, ...immediate };
  if (merged.deposit_limit_day && merged.deposit_limit_week && merged.deposit_limit_day > merged.deposit_limit_week) {
    throw badRequest('O limite diário não pode ser maior que o semanal.');
  }
  if (merged.deposit_limit_week && merged.deposit_limit_month && merged.deposit_limit_week > merged.deposit_limit_month) {
    throw badRequest('O limite semanal não pode ser maior que o mensal.');
  }

  const sets = [];
  const params = [userId];
  for (const [field, value] of Object.entries(immediate)) {
    params.push(value);
    sets.push(`${field} = $${params.length}`);
  }
  if (Object.keys(deferred).length) {
    params.push(JSON.stringify({ ...(current.pending_limits ?? {}), ...deferred }));
    sets.push(`pending_limits = $${params.length}::jsonb`);
    params.push(new Date(Date.now() + COOLDOWN_MS));
    sets.push(`pending_effective_at = $${params.length}`);
  }
  if (sets.length) {
    await client.query(
      `UPDATE responsible_gaming SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`,
      params,
    );
  }

  return {
    immediate,
    deferred,
    effectiveAt: Object.keys(deferred).length ? new Date(Date.now() + COOLDOWN_MS) : null,
  };
}

/** Pausa curta. Diferente da autoexclusão: é mais leve e o jogador escolhe o prazo. */
export async function setPause(client, userId, until) {
  const current = await getSettings(client, userId);
  // Não encurtamos uma pausa já em vigor.
  if (current.paused_until && new Date(current.paused_until) > until) {
    throw badRequest('Já existe uma pausa mais longa em vigor.');
  }
  await client.query(`UPDATE responsible_gaming SET paused_until = $2, updated_at = now() WHERE user_id = $1`, [userId, until]);
}

/** Autoexclusão: sem volta antes do prazo, por desenho. */
export async function setSelfExclusion(client, userId, until) {
  const current = await getSettings(client, userId);
  if (current.self_excluded_until && new Date(current.self_excluded_until) > until) {
    throw badRequest('Já existe uma autoexclusão mais longa em vigor. Ela não pode ser encurtada.');
  }
  await client.query(
    `UPDATE responsible_gaming SET self_excluded_until = $2, updated_at = now() WHERE user_id = $1`,
    [userId, until],
  );
  // Derruba qualquer desafio aberto do jogador e devolve as apostas.
  await client.query(
    `UPDATE challenges SET status = 'cancelled' WHERE creator_id = $1 AND status = 'open'`,
    [userId],
  );
}

/** Lança se o jogador estiver em pausa ou autoexclusão. */
export async function assertCanPlay(client, userId) {
  const s = await getSettings(client, userId);
  const now = new Date();
  if (s.self_excluded_until && new Date(s.self_excluded_until) > now) {
    throw selfExcluded(
      'Você está em autoexclusão. Durante esse período não é possível apostar.',
      { until: s.self_excluded_until, kind: 'self_exclusion' },
    );
  }
  if (s.paused_until && new Date(s.paused_until) > now) {
    throw selfExcluded('Você está em pausa.', { until: s.paused_until, kind: 'pause' });
  }
  return s;
}

/** Quanto o jogador já depositou numa janela. Só conta depósito PAGO. */
export async function depositUsage(client, userId, interval) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS used
       FROM deposits
      WHERE user_id = $1 AND status = 'paid' AND paid_at > now() - $2::interval`,
    [userId, interval],
  );
  return rows[0].used;
}

export async function checkDepositAllowed(client, userId, amountCents) {
  const s = await assertCanPlay(client, userId);
  for (const w of WINDOWS) {
    const limit = s[w.field];
    if (!limit) continue;
    const used = await depositUsage(client, userId, w.interval);
    if (used + amountCents > limit) {
      throw selfExcluded(
        `Este depósito passa do seu limite ${w.label} de ${formatBRL(limit)} (já usado: ${formatBRL(used)}).`,
        { kind: 'deposit_limit', window: w.label, limit, used },
      );
    }
  }
}

/** Quanto o jogador já apostou hoje (apostas travadas em escrow). */
export async function stakeUsageToday(client, userId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(c.stake_cents), 0)::bigint AS used
       FROM challenges c
      WHERE (c.creator_id = $1 OR c.opponent_id = $1)
        AND c.created_at > now() - INTERVAL '1 day'
        AND c.status IN ('staked', 'playing', 'settled')`,
    [userId],
  );
  return rows[0].used;
}

export async function checkStakeAllowed(client, userId, stakeCents) {
  const s = await assertCanPlay(client, userId);
  if (s.stake_limit_day) {
    const used = await stakeUsageToday(client, userId);
    if (used + stakeCents > s.stake_limit_day) {
      throw selfExcluded(
        `Esta aposta passa do seu limite diário de ${formatBRL(s.stake_limit_day)} (já usado: ${formatBRL(used)}).`,
        { kind: 'stake_limit', limit: s.stake_limit_day, used },
      );
    }
  }
}
