/**
 * Rotas da partida, incluindo o fluxo em tempo real por SSE.
 *
 * Por que SSE e não WebSocket: o tráfego aqui é quase todo num sentido só —
 * o servidor avisa o estado novo. A jogada vai por POST comum. SSE reconecta
 * sozinho, atravessa proxy corporativo sem configuração e não exige
 * dependência nenhuma. Para um jogo de turnos é a escolha certa.
 */

import { withTransaction } from '../../db/pool.js';
import { validate, v } from '../../lib/validate.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { limits } from '../../http/rate-limit.js';
import { rollDie, moveToken, getMatchForUser, fairnessProof } from './matches.js';
import { subscribe, publish } from './stream.js';

export function registerMatchRoutes(router) {
  router.get('/api/matches/:id', async (ctx) => {
    const user = ctx.requireAuth();
    return withTransaction((client) => getMatchForUser(client, ctx.params.id, user.user_id));
  });

  router.post('/api/matches/:id/roll', async (ctx) => {
    const user = ctx.requireAuth();
    limits.gameAction(ctx);
    const result = await rollDie({ matchId: ctx.params.id, userId: user.user_id });
    // Avisa o adversário imediatamente.
    publish(ctx.params.id, 'state', result.state);
    return result;
  });

  router.post('/api/matches/:id/move', async (ctx) => {
    const user = ctx.requireAuth();
    limits.gameAction(ctx);
    const { tokenIndex } = validate(ctx.body, { tokenIndex: v.int({ min: 0, max: 3 }) });

    const result = await moveToken({ matchId: ctx.params.id, userId: user.user_id, tokenIndex });
    publish(ctx.params.id, 'state', result.state);
    if (result.settlement) {
      publish(ctx.params.id, 'end', publicSettlement(result.settlement));
    }
    return result;
  });

  /** Prova de lisura: só depois do fim, quando o seed é revelado. */
  router.get('/api/matches/:id/fairness', async (ctx) => {
    const user = ctx.requireAuth();
    await withTransaction((client) => getMatchForUser(client, ctx.params.id, user.user_id));
    return withTransaction((client) => fairnessProof(client, ctx.params.id));
  });

  /** Fluxo em tempo real. */
  router.get('/api/matches/:id/stream', async (ctx) => {
    const user = ctx.requireAuth();
    const matchId = ctx.params.id;

    // Confere a participação ANTES de abrir o fluxo: sem isso qualquer um
    // assistiria a qualquer partida.
    const match = await withTransaction((client) =>
      getMatchForUser(client, matchId, user.user_id),
    );

    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Impede que o nginx segure o fluxo num buffer.
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      if (ctx.res.writableEnded) return;
      ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('state', match.state);
    const unsubscribe = subscribe(matchId, send);

    // Comentário periódico: mantém a conexão viva através de proxies que
    // derrubam conexões ociosas.
    const keepAlive = setInterval(() => {
      if (!ctx.res.writableEnded) ctx.res.write(': ping\n\n');
    }, 25_000);

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
      if (!ctx.res.writableEnded) ctx.res.end();
    };
    ctx.req.on('close', cleanup);
    ctx.req.on('error', cleanup);

    return undefined; // a resposta fica aberta; o app.js não deve finalizá-la
  });
}

/** O que o adversário pode ver ao fim: nunca o seed antes da hora. */
function publicSettlement(s) {
  return {
    voided: s.voided === true,
    winnerColor: s.winnerColor ?? null,
    potCents: s.potCents ?? 0,
    prizeCents: s.prizeCents ?? 0,
    commissionCents: s.commissionCents ?? 0,
  };
}
