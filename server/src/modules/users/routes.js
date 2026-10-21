/**
 * Perfil, KYC e jogo responsável.
 *
 * O CPF é guardado só como hash (para checar duplicidade) mais os três
 * dígitos do meio (para a máscara na tela). O número completo não fica no
 * banco: ele serve para verificar identidade uma vez, não para ser estocado.
 */

import { config } from '../../config.js';
import { withTransaction } from '../../db/pool.js';
import { validate, v, isValidCPF, cpfDigits, ageFrom } from '../../lib/validate.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { blindIndex } from '../../lib/passwords.js';
import {
  getSettings, updateLimits, setPause, setSelfExclusion,
} from './responsible-gaming.js';

export function registerUserRoutes(router) {
  router.get('/api/me/profile', async (ctx) => {
    const user = ctx.requireAuth();
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT email, display_name, full_name, cpf_last3, birth_date, phone,
                country, city, uf, kyc_level, doc_status, doc_filename,
                doc_reject_reason, created_at
           FROM users WHERE id = $1`,
        [user.user_id],
      );
      return rows[0];
    });

    return {
      email: row.email,
      displayName: row.display_name,
      fullName: row.full_name,
      cpfMasked: row.cpf_last3 ? `***.***.${row.cpf_last3}-**` : null,
      birthDate: row.birth_date,
      phone: row.phone,
      country: row.country,
      city: row.city,
      uf: row.uf,
      kycLevel: row.kyc_level,
      docStatus: row.doc_status,
      docRejectReason: row.doc_reject_reason,
      createdAt: row.created_at,
    };
  });

  router.put('/api/me/profile', async (ctx) => {
    const user = ctx.requireAuth();
    const data = validate(ctx.body, {
      displayName: v.optional(v.string({ min: 2, max: 30 })),
      fullName: v.optional(v.string({ min: 5, max: 120 })),
      cpf: v.optional(v.string({ min: 11, max: 14 })),
      phone: v.optional(v.string({ min: 10, max: 20 })),
      city: v.optional(v.string({ min: 2, max: 80 })),
      uf: v.optional(v.string({ min: 2, max: 2 })),
      country: v.optional(v.string({ min: 2, max: 2 })),
    });

    if (data.fullName && data.fullName.trim().split(/\s+/).length < 2) {
      throw badRequest('Informe o nome completo.');
    }

    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT cpf_hash, kyc_level, birth_date, doc_status FROM users WHERE id = $1 FOR UPDATE`,
        [user.user_id],
      );
      const current = rows[0];

      let cpfHash = null;
      let cpfLast3 = null;
      if (data.cpf) {
        const digits = cpfDigits(data.cpf);
        if (!isValidCPF(digits)) throw badRequest('CPF inválido.');
        cpfHash = blindIndex(config.SESSION_SECRET, digits);

        // Conta já verificada não troca de CPF sozinha: seria o caminho para
        // transferir uma conta verificada a outra pessoa.
        if (current.cpf_hash && current.cpf_hash !== cpfHash && current.kyc_level === 'verified') {
          throw forbidden('Conta verificada não pode trocar de CPF. Fale com o suporte.');
        }
        // Um CPF, uma conta.
        const { rows: dup } = await client.query(
          `SELECT 1 FROM users WHERE cpf_hash = $1 AND id <> $2`,
          [cpfHash, user.user_id],
        );
        if (dup[0]) throw conflict('Já existe uma conta com este CPF.');
        cpfLast3 = digits.slice(6, 9);
      }

      await client.query(
        `UPDATE users SET
           display_name = COALESCE($2, display_name),
           full_name    = COALESCE($3, full_name),
           cpf_hash     = COALESCE($4, cpf_hash),
           cpf_last3    = COALESCE($5, cpf_last3),
           phone        = COALESCE($6, phone),
           city         = COALESCE($7, city),
           uf           = COALESCE($8, uf),
           country      = COALESCE($9, country),
           updated_at   = now()
         WHERE id = $1`,
        [
          user.user_id, data.displayName ?? null, data.fullName ?? null,
          cpfHash, cpfLast3, data.phone ?? null, data.city ?? null,
          data.uf?.toUpperCase() ?? null, data.country?.toUpperCase() ?? null,
        ],
      );

      // Nível 2 quando os dados pessoais estão completos.
      const { rows: after } = await client.query(
        `SELECT full_name, cpf_hash, birth_date, phone, country, doc_status, kyc_level
           FROM users WHERE id = $1`,
        [user.user_id],
      );
      const u = after[0];
      const complete = !!(u.full_name && u.cpf_hash && u.birth_date && u.phone && u.country);
      const level = !complete ? 'registered' : (u.doc_status === 'approved' ? 'verified' : 'personal_data');

      if (level !== u.kyc_level) {
        await client.query(`UPDATE users SET kyc_level = $2 WHERE id = $1`, [user.user_id, level]);
      }
      return { ok: true, kycLevel: level };
    });
  });

  /* ---------------- jogo responsável ---------------- */

  router.get('/api/me/limits', async (ctx) => {
    const user = ctx.requireAuth();
    const s = await withTransaction((client) => getSettings(client, user.user_id));
    return {
      depositLimitDay: s.deposit_limit_day,
      depositLimitWeek: s.deposit_limit_week,
      depositLimitMonth: s.deposit_limit_month,
      stakeLimitDay: s.stake_limit_day,
      pendingLimits: s.pending_limits,
      pendingEffectiveAt: s.pending_effective_at,
      pausedUntil: s.paused_until,
      selfExcludedUntil: s.self_excluded_until,
    };
  });

  router.put('/api/me/limits', async (ctx) => {
    const user = ctx.requireAuth();
    const data = validate(ctx.body, {
      depositLimitDay: v.optional(v.int({ min: 0 })),
      depositLimitWeek: v.optional(v.int({ min: 0 })),
      depositLimitMonth: v.optional(v.int({ min: 0 })),
      stakeLimitDay: v.optional(v.int({ min: 0 })),
    });

    // 0 significa "remover o limite".
    const requested = {};
    const map = {
      depositLimitDay: 'deposit_limit_day',
      depositLimitWeek: 'deposit_limit_week',
      depositLimitMonth: 'deposit_limit_month',
      stakeLimitDay: 'stake_limit_day',
    };
    for (const [key, column] of Object.entries(map)) {
      if (key in data) requested[column] = data[key] === 0 ? null : data[key];
    }

    const result = await withTransaction((client) => updateLimits(client, user.user_id, requested));
    return {
      ...result,
      message: Object.keys(result.deferred).length
        ? 'Os limites mais restritivos valem agora. Afrouxar um limite só passa a valer em 24 horas.'
        : 'Limites atualizados.',
    };
  });

  router.post('/api/me/pause', async (ctx) => {
    const user = ctx.requireAuth();
    const { hours } = validate(ctx.body, { hours: v.int({ min: 1, max: 24 * 30 }) });
    const until = new Date(Date.now() + hours * 3_600_000);
    await withTransaction((client) => setPause(client, user.user_id, until));
    return { pausedUntil: until };
  });

  router.post('/api/me/self-exclusion', async (ctx) => {
    const user = ctx.requireAuth();
    const { days, confirm } = validate(ctx.body, {
      days: v.int({ min: 1, max: 365 * 5 }),
      confirm: v.bool(),
    });
    // Confirmação explícita: é irreversível.
    if (!confirm) {
      throw badRequest('A autoexclusão não pode ser desfeita antes do prazo. Confirme para continuar.');
    }
    const until = new Date(Date.now() + days * 86_400_000);
    await withTransaction(async (client) => {
      await setSelfExclusion(client, user.user_id, until);
      await client.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
         VALUES ($1::uuid, 'user.self_excluded', 'user', $1::text, $2)`,
        [user.user_id, JSON.stringify({ days, until })],
      );
    });
    return {
      selfExcludedUntil: until,
      message: 'Autoexclusão registrada. Você ainda pode sacar seu saldo, mas não apostar.',
    };
  });
}
