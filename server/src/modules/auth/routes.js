/**
 * Rotas de autenticação.
 *
 * Decisões que importam:
 *  • A resposta de login é a MESMA para "e-mail não existe" e "senha errada".
 *    Mensagens distintas transformam o login num verificador de contas.
 *  • Mesmo quando o e-mail não existe, gastamos o tempo de um scrypt. Sem
 *    isso, a diferença de tempo de resposta denuncia quais e-mails existem.
 *  • Conta nova NÃO nasce com saldo. O faucet "+R$50" do protótipo não tem
 *    equivalente aqui.
 */

import { withTransaction } from '../../db/pool.js';
import { validate, v, ageFrom } from '../../lib/validate.js';
import { badRequest, unauthorized, conflict, forbidden } from '../../lib/errors.js';
import { hashPassword, verifyPassword, needsRehash } from '../../lib/passwords.js';
import { limits } from '../../http/rate-limit.js';
import * as ledger from '../wallet/ledger.js';
import {
  createSession, revokeSession, revokeAllSessions, sessionCookies, clearCookies,
} from './sessions.js';

/** Hash descartável, só para consumir tempo quando o e-mail não existe. */
const DUMMY_HASH = await hashPassword('conta-inexistente-placeholder-0123456789');

export function registerAuthRoutes(router) {
  /* -------------------- cadastro -------------------- */
  router.post('/api/auth/signup', async (ctx) => {
    limits.signup(ctx);

    const data = validate(ctx.body, {
      email: v.email(),
      password: v.password(),
      displayName: v.string({ min: 2, max: 30 }),
      birthDate: v.isoDate(),
      acceptedTerms: v.bool(),
    });

    if (!data.acceptedTerms) throw badRequest('É preciso aceitar os termos de uso.');
    // Maior de 18: checado aqui e de novo por constraint no banco.
    if (ageFrom(data.birthDate) < 18) {
      throw forbidden('É preciso ter 18 anos ou mais para criar uma conta.');
    }

    const passwordHash = await hashPassword(data.password);

    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`SELECT 1 FROM users WHERE email = $1`, [data.email]);
      if (existing[0]) throw conflict('Já existe uma conta com este e-mail.');

      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, display_name, birth_date)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, kyc_level, doc_status, is_admin`,
        [data.email, passwordHash, data.displayName, data.birthDate],
      );
      const user = rows[0];

      // Carteira criada já com saldo ZERO. Nada de bônus automático.
      await ledger.ensureUserAccount(client, user.id);
      await client.query(`INSERT INTO responsible_gaming (user_id) VALUES ($1)`, [user.id]);
      await client.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, ip)
         VALUES ($1, 'user.signup', 'user', $1, $2)`,
        [user.id, ctx.ip],
      );

      const session = await createSession(client, {
        userId: user.id, userAgent: ctx.req.headers['user-agent'], ip: ctx.ip,
      });
      return { user, session };
    });

    ctx.setCookies(sessionCookies(result.session));
    return { user: publicUser(result.user), balanceCents: 0 };
  });

  /* -------------------- login -------------------- */
  router.post('/api/auth/login', async (ctx) => {
    limits.loginByIp(ctx);
    limits.loginByAccount(ctx);

    const data = validate(ctx.body, {
      email: v.email(),
      password: v.string({ min: 1, max: 200, trim: false }),
    });

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, email, password_hash, display_name, kyc_level, doc_status,
                is_admin, is_frozen, frozen_reason, locked_until, failed_logins
           FROM users WHERE email = $1`,
        [data.email],
      );
      const user = rows[0];

      if (!user) {
        // Gasta o mesmo tempo de um login real para não vazar que o e-mail
        // não existe pela latência da resposta.
        await verifyPassword(data.password, DUMMY_HASH);
        throw unauthorized('E-mail ou senha incorretos.');
      }

      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        throw unauthorized('Conta temporariamente bloqueada por tentativas seguidas. Tente mais tarde.');
      }

      const ok = await verifyPassword(data.password, user.password_hash);
      if (!ok) {
        const fails = user.failed_logins + 1;
        // Bloqueio progressivo após 5 erros: 15 minutos.
        await client.query(
          `UPDATE users SET failed_logins = $2,
                            locked_until = CASE WHEN $2 >= 5 THEN now() + INTERVAL '15 minutes' ELSE locked_until END
            WHERE id = $1`,
          [user.id, fails],
        );
        throw unauthorized('E-mail ou senha incorretos.');
      }

      if (user.is_frozen) {
        throw forbidden(user.frozen_reason ? `Conta bloqueada: ${user.frozen_reason}` : 'Conta bloqueada.');
      }

      // Se o custo do scrypt subiu desde o cadastro, reforçamos agora que
      // temos a senha em mãos.
      if (needsRehash(user.password_hash)) {
        const fresh = await hashPassword(data.password);
        await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, fresh]);
      }

      await client.query(
        `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`,
        [user.id],
      );
      await ledger.ensureUserAccount(client, user.id);

      const session = await createSession(client, {
        userId: user.id, userAgent: ctx.req.headers['user-agent'], ip: ctx.ip,
      });
      const balanceCents = await ledger.getBalance(client, user.id);
      return { user, session, balanceCents };
    });

    ctx.setCookies(sessionCookies(result.session));
    return { user: publicUser(result.user), balanceCents: result.balanceCents };
  });

  /* -------------------- logout -------------------- */
  router.post('/api/auth/logout', async (ctx) => {
    if (ctx.session) {
      await withTransaction((client) => revokeSession(client, ctx.session.id));
    }
    ctx.setCookies(clearCookies());
    return { ok: true };
  });

  /** Sai de todos os aparelhos — útil se o jogador suspeitar de invasão. */
  router.post('/api/auth/logout-all', async (ctx) => {
    const user = ctx.requireAuth();
    await withTransaction((client) => revokeAllSessions(client, user.user_id ?? user.id));
    ctx.setCookies(clearCookies());
    return { ok: true };
  });

  /* -------------------- quem sou eu -------------------- */
  router.get('/api/auth/me', async (ctx) => {
    if (!ctx.user) return { user: null };
    const balanceCents = await withTransaction((client) =>
      ledger.getBalance(client, ctx.user.user_id),
    );
    return {
      user: publicUser({ ...ctx.user, id: ctx.user.user_id }),
      balanceCents,
      csrfToken: ctx.session?.csrf_secret ?? null,
    };
  });

  /* -------------------- troca de senha -------------------- */
  router.post('/api/auth/change-password', async (ctx) => {
    const user = ctx.requireAuth();
    const data = validate(ctx.body, {
      currentPassword: v.string({ min: 1, max: 200, trim: false }),
      newPassword: v.password(),
    });

    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`,
        [user.user_id],
      );
      if (!(await verifyPassword(data.currentPassword, rows[0].password_hash))) {
        throw unauthorized('Senha atual incorreta.');
      }
      const fresh = await hashPassword(data.newPassword);
      await client.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [
        user.user_id, fresh,
      ]);
      // Trocar a senha derruba as OUTRAS sessões: se alguém estava dentro,
      // perde o acesso agora.
      await revokeAllSessions(client, user.user_id, { except: ctx.session.id });
      await client.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, ip)
         VALUES ($1, 'user.password_changed', 'user', $1, $2)`,
        [user.user_id, ctx.ip],
      );
    });

    return { ok: true, message: 'Senha alterada. As outras sessões foram encerradas.' };
  });
}

function publicUser(u) {
  return {
    id: u.id ?? u.user_id,
    email: u.email,
    displayName: u.display_name,
    kycLevel: u.kyc_level,
    docStatus: u.doc_status,
    isAdmin: u.is_admin === true,
  };
}
