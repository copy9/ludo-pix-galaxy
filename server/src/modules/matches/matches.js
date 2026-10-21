/**
 * Partidas — o servidor é o árbitro.
 *
 * No protótipo, o navegador sorteava o dado, decidia a jogada e empurrava o
 * estado inteiro para o banco (`syncPush`). Quem abrisse o console vencia.
 *
 * Aqui o cliente só pode fazer duas coisas: pedir um lance e pedir um
 * movimento. Tudo o mais é decidido aqui:
 *   • o dado vem do commit–reveal, não do cliente;
 *   • a jogada é validada pelo motor de regras;
 *   • cada evento vai para um log append-only;
 *   • antes de pagar, a partida é REEXECUTADA a partir do log. Se o estado
 *     final reconstruído não bater com o estado guardado, ninguém recebe e o
 *     desafio é anulado com devolução das apostas.
 */

import { config } from '../../config.js';
import { withRetryableTransaction, withTransaction } from '../../db/pool.js';
import { badRequest, notFound, conflict, forbidden } from '../../lib/errors.js';
import { rollFromSeeds } from '../../lib/rng.js';
import {
  applyRoll, applyMove, applyNoMove, legalMoves, currentPlayer, replay, RuleError,
} from '../../../../shared/ludo-rules.js';
import { settleChallenge, voidChallenge } from '../challenges/challenges.js';

/** Carrega a partida e confere que quem pede faz parte dela. */
async function loadMatchForUser(client, matchId, userId, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `SELECT m.*, c.id AS challenge_id, c.creator_id, c.opponent_id, c.stake_cents, c.status AS challenge_status
       FROM matches m JOIN challenges c ON c.id = m.challenge_id
      WHERE m.id = $1 ${forUpdate ? 'FOR UPDATE OF m' : ''}`,
    [matchId],
  );
  const match = rows[0];
  if (!match) throw notFound('Partida não encontrada.');

  const myColor = match.color_by_user?.[userId];
  if (!myColor) throw forbidden('Você não faz parte desta partida.');
  return { match, myColor };
}

const nextSeq = async (client, matchId) => {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM match_events WHERE match_id = $1`,
    [matchId],
  );
  return rows[0].next;
};

async function logEvent(client, { matchId, seq, type, payload, actorId }) {
  await client.query(
    `INSERT INTO match_events (match_id, seq, type, payload, actor_id) VALUES ($1, $2, $3, $4, $5)`,
    [matchId, seq, type, JSON.stringify(payload), actorId ?? null],
  );
}

/**
 * Lança o dado.
 *
 * O valor sai de HMAC(serverSeed, clientSeed:matchId:nonce). O nonce avança
 * a cada lance, então a sequência é fixa desde antes da partida começar — o
 * servidor não consegue escolher o resultado depois de ver o tabuleiro.
 */
export async function rollDie({ matchId, userId }) {
  return withRetryableTransaction(async (client) => {
    const { match, myColor } = await loadMatchForUser(client, matchId, userId, { forUpdate: true });
    if (match.status !== 'active') throw conflict('Esta partida já terminou.');

    const state = match.state;
    if (state.gameOver) throw conflict('Esta partida já terminou.');
    if (currentPlayer(state).color !== myColor) throw forbidden('Não é a sua vez.');
    if (state.die !== null) throw conflict('Você já lançou o dado. Mova uma peça.');

    const die = rollFromSeeds({
      serverSeed: match.server_seed,
      clientSeed: match.client_seed,
      matchId: match.id,
      nonce: match.nonce,
    });

    let result;
    try {
      result = applyRoll(state, die);
    } catch (err) {
      if (err instanceof RuleError) throw badRequest(err.message);
      throw err;
    }

    const seq = await nextSeq(client, matchId);
    await logEvent(client, { matchId, seq, type: 'roll', payload: { die }, actorId: userId });

    // Sem jogada possível: o próprio servidor passa a vez, para o cliente não
    // conseguir travar a partida simplesmente não chamando "passar".
    let autoPass = null;
    if (result.moves.length === 0) {
      applyNoMove(state);
      await logEvent(client, {
        matchId, seq: seq + 1, type: 'no_move', payload: { die }, actorId: null,
      });
      autoPass = { die, extraTurn: die === 6 };
    }

    await client.query(
      `UPDATE matches SET state = $2, nonce = nonce + 1,
                          turn_deadline = now() + ($3 || ' seconds')::interval
        WHERE id = $1`,
      [matchId, JSON.stringify(state), String(config.TURN_TIMEOUT_SECONDS)],
    );

    return { die, moves: result.moves, autoPass, state: publicState(state, match) };
  });
}

/** Move uma peça. A legalidade é decidida pelo motor, não pelo cliente. */
export async function moveToken({ matchId, userId, tokenIndex }) {
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 3) {
    throw badRequest('Peça inválida.');
  }

  return withRetryableTransaction(async (client) => {
    const { match, myColor } = await loadMatchForUser(client, matchId, userId, { forUpdate: true });
    if (match.status !== 'active') throw conflict('Esta partida já terminou.');

    const state = match.state;
    if (state.gameOver) throw conflict('Esta partida já terminou.');
    if (currentPlayer(state).color !== myColor) throw forbidden('Não é a sua vez.');
    if (state.die === null) throw badRequest('Lance o dado primeiro.');

    let report;
    try {
      report = applyMove(state, tokenIndex);
    } catch (err) {
      if (err instanceof RuleError) throw badRequest(err.message);
      throw err;
    }

    const seq = await nextSeq(client, matchId);
    await logEvent(client, { matchId, seq, type: 'move', payload: { tokenIndex }, actorId: userId });

    await client.query(
      `UPDATE matches SET state = $2, turn_deadline = now() + ($3 || ' seconds')::interval
        WHERE id = $1`,
      [matchId, JSON.stringify(state), String(config.TURN_TIMEOUT_SECONDS)],
    );

    let settlement = null;
    if (state.gameOver) {
      settlement = await finishMatch(client, { match, state });
    }

    return { report, state: publicState(state, match), settlement };
  });
}

/**
 * Encerra a partida e dispara o pagamento.
 *
 * A VERIFICAÇÃO INDEPENDENTE acontece aqui: reexecutamos todos os eventos do
 * log num estado limpo e comparamos com o estado guardado. É o que garante
 * que nenhum caminho de código conseguiu escrever um vencedor direto.
 */
async function finishMatch(client, { match, state }) {
  const { rows: events } = await client.query(
    `SELECT type, payload FROM match_events WHERE match_id = $1 ORDER BY seq ASC`,
    [match.id],
  );

  const colors = state.players.map((p) => p.color);
  let verified;
  try {
    verified = replay(
      { colors, teams: state.teams ?? null },
      events.map((e) => ({ type: e.type, ...e.payload })),
    );
  } catch (err) {
    await voidChallenge(client, {
      challengeId: match.challenge_id,
      reason: `Log da partida não reexecuta: ${err.message}`,
    });
    await client.query(`UPDATE matches SET status = 'voided', finished_at = now() WHERE id = $1`, [match.id]);
    return { voided: true, reason: 'log_inconsistente' };
  }

  const matches =
    verified.gameOver &&
    verified.winnerColor === state.winnerColor &&
    JSON.stringify(verified.players) === JSON.stringify(state.players);

  if (!matches) {
    // Na dúvida, ninguém recebe e as apostas voltam.
    await voidChallenge(client, {
      challengeId: match.challenge_id,
      reason: 'Estado final não confere com a reexecução do log',
    });
    await client.query(`UPDATE matches SET status = 'voided', finished_at = now() WHERE id = $1`, [match.id]);
    return { voided: true, reason: 'estado_divergente' };
  }

  const winnerUserId = Object.keys(match.color_by_user).find(
    (uid) => match.color_by_user[uid] === state.winnerColor,
  );

  await client.query(
    `UPDATE matches SET status = 'finished', winner_color = $2, finished_at = now(),
                        seed_revealed_at = now(), turn_deadline = NULL
      WHERE id = $1`,
    [match.id, state.winnerColor],
  );

  const settled = await settleChallenge(client, {
    challengeId: match.challenge_id,
    winnerUserId,
  });

  return {
    voided: false,
    winnerUserId,
    winnerColor: state.winnerColor,
    ...settled,
    // Revelamos o seed agora: o jogador pode conferir todos os lances.
    fairness: {
      serverSeed: match.server_seed,
      serverSeedHash: match.server_seed_hash,
      clientSeed: match.client_seed,
      matchId: match.id,
      rolls: match.nonce,
    },
  };
}

/**
 * Turno estourado: o jogador perde a vez.
 *
 * Sem isso, quem estivesse perdendo um desafio valendo dinheiro poderia
 * simplesmente fechar o navegador e deixar o dinheiro preso no escrow para
 * sempre.
 */
export async function timeoutTurn(matchId) {
  return withRetryableTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.*, c.id AS challenge_id, c.creator_id, c.opponent_id
         FROM matches m JOIN challenges c ON c.id = m.challenge_id
        WHERE m.id = $1 AND m.status = 'active' AND m.turn_deadline < now()
        FOR UPDATE OF m`,
      [matchId],
    );
    const match = rows[0];
    if (!match) return { skipped: true };

    const state = match.state;
    const seq = await nextSeq(client, matchId);

    if (state.die === null) {
      // Nem lançou: lançamos por ele e, se houver jogada, ele perde a vez.
      const die = rollFromSeeds({
        serverSeed: match.server_seed,
        clientSeed: match.client_seed,
        matchId: match.id,
        nonce: match.nonce,
      });
      applyRoll(state, die);
      await logEvent(client, { matchId, seq, type: 'roll', payload: { die }, actorId: null });

      const moves = legalMoves(state, currentPlayer(state), die);
      if (moves.length === 0) {
        applyNoMove(state);
        await logEvent(client, { matchId, seq: seq + 1, type: 'no_move', payload: { die }, actorId: null });
      } else {
        // Joga a primeira peça legal: passar a vez com jogada disponível
        // deixaria o jogador travar a partida de propósito.
        applyMove(state, moves[0]);
        await logEvent(client, {
          matchId, seq: seq + 1, type: 'move', payload: { tokenIndex: moves[0] }, actorId: null,
        });
      }
      await client.query(`UPDATE matches SET nonce = nonce + 1 WHERE id = $1`, [matchId]);
    } else {
      const moves = legalMoves(state, currentPlayer(state), state.die);
      if (moves.length === 0) {
        applyNoMove(state);
        await logEvent(client, { matchId, seq, type: 'no_move', payload: { die: state.die }, actorId: null });
      } else {
        applyMove(state, moves[0]);
        await logEvent(client, { matchId, seq, type: 'move', payload: { tokenIndex: moves[0] }, actorId: null });
      }
    }

    await client.query(
      `UPDATE matches SET state = $2, turn_deadline = now() + ($3 || ' seconds')::interval WHERE id = $1`,
      [matchId, JSON.stringify(state), String(config.TURN_TIMEOUT_SECONDS)],
    );

    let settlement = null;
    if (state.gameOver) settlement = await finishMatch(client, { match, state });

    return { skipped: false, state: publicState(state, match), settlement };
  });
}

/** Varre partidas com turno estourado. Chamado pelo agendador. */
export async function sweepTimeouts() {
  const { rows } = await withTransaction((client) =>
    client.query(
      `SELECT id FROM matches WHERE status = 'active' AND turn_deadline < now() LIMIT 50`,
    ),
  );
  let handled = 0;
  for (const row of rows) {
    try {
      const r = await timeoutTurn(row.id);
      if (!r.skipped) handled += 1;
    } catch (err) {
      console.error(`[matches] falha no timeout de ${row.id}:`, err.message);
    }
  }
  return handled;
}

/**
 * Estado que vai para o cliente.
 * O `server_seed` NUNCA sai daqui antes do fim — é o que torna o
 * commit–reveal honesto.
 */
function publicState(state, match) {
  return {
    players: state.players,
    teams: state.teams,
    turnIndex: state.turnIndex,
    die: state.die,
    turnNumber: state.turnNumber,
    gameOver: state.gameOver,
    winnerColor: state.winnerColor,
    ranking: state.ranking,
    legalMoves: state.die === null || state.gameOver
      ? []
      : legalMoves(state, currentPlayer(state), state.die),
  };
}

export async function getMatchForUser(client, matchId, userId) {
  const { match, myColor } = await loadMatchForUser(client, matchId, userId);
  return {
    id: match.id,
    challengeId: match.challenge_id,
    status: match.status,
    myColor,
    stakeCents: match.stake_cents,
    turnDeadline: match.turn_deadline,
    serverSeedHash: match.server_seed_hash,
    clientSeed: match.client_seed,
    // Só depois do fim.
    serverSeed: match.status === 'finished' ? match.server_seed : null,
    state: publicState(match.state, match),
  };
}

/** Dados para o jogador auditar a lisura do dado depois da partida. */
export async function fairnessProof(client, matchId) {
  const { rows } = await client.query(
    `SELECT id, status, server_seed, server_seed_hash, client_seed, nonce FROM matches WHERE id = $1`,
    [matchId],
  );
  const m = rows[0];
  if (!m) throw notFound('Partida não encontrada.');
  if (m.status !== 'finished') {
    throw conflict('O seed só é revelado quando a partida termina.');
  }
  const { rows: events } = await client.query(
    `SELECT seq, type, payload FROM match_events WHERE match_id = $1 ORDER BY seq`,
    [matchId],
  );
  return {
    matchId: m.id,
    serverSeed: m.server_seed,
    serverSeedHash: m.server_seed_hash,
    clientSeed: m.client_seed,
    rollCount: m.nonce,
    events,
  };
}
