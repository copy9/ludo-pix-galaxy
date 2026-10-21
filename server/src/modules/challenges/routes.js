/**
 * Rotas de desafio.
 *
 * Note o que NÃO existe aqui: nenhuma rota para reportar o vencedor. Era
 * `POST reportWinner` no protótipo, e era por onde se roubava. O vencedor
 * sai do motor de regras quando a partida acaba, e ponto.
 */

import { withTransaction } from '../../db/pool.js';
import { validate, v } from '../../lib/validate.js';
import { config } from '../../config.js';
import { limits } from '../../http/rate-limit.js';
import {
  createChallenge, joinChallenge, cancelChallenge, getChallengeByCode, listMyChallenges,
} from './challenges.js';

export function registerChallengeRoutes(router) {
  router.post('/api/challenges', async (ctx) => {
    const user = ctx.requireAuth();
    limits.createChallenge(ctx);

    const data = validate(ctx.body, {
      free: v.optional(v.bool(), false),
      amount: v.optional(v.string({ min: 1, max: 20 })),
      country: v.optional(v.string({ min: 2, max: 2 })),
    });

    const challenge = await createChallenge({
      userId: user.user_id,
      stakeInput: data.amount,
      free: data.free === true,
      country: data.country,
    });

    return {
      code: challenge.code,
      stakeCents: challenge.stake_cents,
      commissionBps: challenge.commission_bps,
      status: challenge.status,
      expiresAt: challenge.expires_at,
    };
  });

  router.get('/api/challenges', async (ctx) => {
    const user = ctx.requireAuth();
    const rows = await withTransaction((client) => listMyChallenges(client, user.user_id));
    return {
      challenges: rows.map((r) => ({
        code: r.code,
        stakeCents: r.stake_cents,
        status: r.status,
        iWon: r.winner_id === user.user_id,
        iCreated: r.creator_id === user.user_id,
        createdAt: r.created_at,
        settledAt: r.settled_at,
      })),
    };
  });

  router.get('/api/challenges/:code', async (ctx) => {
    const code = String(ctx.params.code).toUpperCase().slice(0, 12);
    const userId = ctx.user?.user_id ?? null;
    const c = await withTransaction((client) => getChallengeByCode(client, code, userId));

    return {
      code: c.code,
      status: c.status,
      stakeCents: c.stake_cents,
      commissionBps: c.commission_bps,
      creatorId: c.creator_id,
      opponentId: c.opponent_id,
      // Nomes dos participantes só para quem está no desafio.
      creatorName: c.isParticipant || c.status === 'open' ? c.creator_name : null,
      opponentName: c.isParticipant ? c.opponent_name : null,
      winnerId: c.winner_id,
      matchId: c.isParticipant ? c.match_id : null,
      expiresAt: c.expires_at,
      settledAt: c.settled_at,
    };
  });

  router.post('/api/challenges/:code/join', async (ctx) => {
    const user = ctx.requireAuth();
    limits.createChallenge(ctx);
    const code = String(ctx.params.code).toUpperCase().slice(0, 12);
    const { country } = validate(ctx.body, { country: v.optional(v.string({ min: 2, max: 2 })) });

    const result = await joinChallenge({ code, userId: user.user_id, country });
    return {
      match: { id: result.match.id, serverSeedHash: result.match.server_seed_hash },
      myColor: result.myColor,
      stakeCents: result.challenge.stake_cents,
    };
  });

  router.post('/api/challenges/:code/cancel', async (ctx) => {
    const user = ctx.requireAuth();
    const code = String(ctx.params.code).toUpperCase().slice(0, 12);
    return cancelChallenge({ code, userId: user.user_id });
  });
}
