/**
 * Desafios: criação, aceite com escrow e liquidação do prêmio.
 *
 * O protótipo perguntava a cada jogador quem tinha vencido e pagava pela
 * resposta. Além de confiar no jogador, tinha dois defeitos fatais:
 *   • `update({reports: rep})` apagava o voto do adversário, então um desafio
 *     real entre duas pessoas nunca se resolvia e o dinheiro ficava preso;
 *   • contra o `sim_bot` bastava um voto — apostar, dizer que venceu, sacar.
 *
 * Aqui ninguém vota. O vencedor sai do motor de regras depois de o servidor
 * reexecutar a partida inteira a partir do log de eventos.
 */

import { config } from '../../config.js';
import { withTransaction, withRetryableTransaction } from '../../db/pool.js';
import { badRequest, notFound, conflict, forbidden } from '../../lib/errors.js';
import { requirePositiveCents, splitPot, formatBRL } from '../../lib/money.js';
import { challengeCode, generateServerSeed, generateClientSeed, commitFor } from '../../lib/rng.js';
import { createGame } from '../../../../shared/ludo-rules.js';
import * as ledger from '../wallet/ledger.js';
import { checkStakeAllowed, assertCanPlay } from '../users/responsible-gaming.js';

/** Cria um desafio. Se tiver aposta, o valor do criador já vai para o escrow. */
export async function createChallenge({ userId, stakeInput, free = false, country }) {
  const stakeCents = free
    ? 0
    : requirePositiveCents(stakeInput, {
        min: config.MIN_STAKE_CENTS,
        max: config.MAX_STAKE_CENTS,
        label: 'valor da aposta',
      });

  return withRetryableTransaction(async (client) => {
    await assertCanPlay(client, userId);
    if (stakeCents > 0) await checkStakeAllowed(client, userId, stakeCents);

    const { rows: openRows } = await client.query(
      `SELECT count(*)::int AS n FROM challenges
        WHERE creator_id = $1 AND status = 'open' AND expires_at > now()`,
      [userId],
    );
    if (openRows[0].n >= 3) {
      throw conflict('Você já tem desafios abertos demais. Cancele um antes de criar outro.');
    }

    // Código único, com algumas tentativas em caso de colisão improvável.
    let code = null;
    for (let i = 0; i < 5 && !code; i += 1) {
      const candidate = challengeCode(6);
      const { rows } = await client.query(`SELECT 1 FROM challenges WHERE code = $1`, [candidate]);
      if (!rows[0]) code = candidate;
    }
    if (!code) throw new Error('Não consegui gerar um código de desafio.');

    const expiresAt = new Date(Date.now() + config.CHALLENGE_TTL_MINUTES * 60_000);
    const { rows } = await client.query(
      `INSERT INTO challenges (code, creator_id, stake_cents, commission_bps, creator_country, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, stake_cents, commission_bps, status, expires_at, created_at`,
      [code, userId, stakeCents, config.COMMISSION_BPS, country ?? null, expiresAt],
    );
    const challenge = rows[0];

    if (stakeCents > 0) {
      await holdStake(client, { userId, challengeId: challenge.id, stakeCents, side: 'creator' });
    }

    return challenge;
  });
}

/** Trava a aposta de um jogador no escrow. */
async function holdStake(client, { userId, challengeId, stakeCents, side }) {
  const walletId = await ledger.ensureUserAccount(client, userId);
  const escrowId = await ledger.systemAccountId(client, 'escrow');
  return ledger.transfer(client, {
    fromAccountId: walletId,
    toAccountId: escrowId,
    amountCents: stakeCents,
    reason: 'stake_hold',
    // A chave inclui o lado: criador e adversário geram lançamentos distintos
    // para o mesmo desafio, mas cada um só pode acontecer uma vez.
    idempotencyKey: `stake:${challengeId}:${side}`,
    referenceType: 'challenge',
    referenceId: challengeId,
    memo: 'Aposta travada em desafio',
  });
}

/** Entra num desafio aberto. É aqui que a partida nasce. */
export async function joinChallenge({ code, userId, country }) {
  return withRetryableTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM challenges WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const challenge = rows[0];
    if (!challenge) throw notFound('Desafio não encontrado.');

    if (challenge.creator_id === userId) {
      // A constraint do banco também barra, mas a mensagem daqui é melhor.
      throw badRequest('Você não pode entrar no seu próprio desafio.');
    }
    if (challenge.status !== 'open') throw conflict('Este desafio não está mais aberto.');
    if (new Date(challenge.expires_at) < new Date()) throw conflict('Este desafio expirou.');

    await assertCanPlay(client, userId);
    if (challenge.stake_cents > 0) {
      await checkStakeAllowed(client, userId, challenge.stake_cents);
      await holdStake(client, {
        userId, challengeId: challenge.id, stakeCents: challenge.stake_cents, side: 'opponent',
      });
    }

    await client.query(
      `UPDATE challenges SET opponent_id = $2, opponent_country = $3, status = 'playing'
        WHERE id = $1`,
      [challenge.id, userId, country ?? null],
    );

    // --- nasce a partida ---
    const serverSeed = generateServerSeed();
    const clientSeed = generateClientSeed();
    const state = createGame({ colors: ['red', 'blue'] });
    // O criador é sempre vermelho e começa; é determinístico e auditável.
    const colorByUser = { [challenge.creator_id]: 'red', [userId]: 'blue' };

    const { rows: matchRows } = await client.query(
      `INSERT INTO matches (challenge_id, state, server_seed, server_seed_hash, client_seed,
                            color_by_user, turn_deadline)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)
       RETURNING id, server_seed_hash, started_at, turn_deadline`,
      [
        challenge.id,
        JSON.stringify(state),
        serverSeed,
        commitFor(serverSeed),
        clientSeed,
        JSON.stringify(colorByUser),
        String(config.TURN_TIMEOUT_SECONDS),
      ],
    );

    return {
      challenge: { ...challenge, opponent_id: userId, status: 'playing' },
      match: matchRows[0],
      myColor: 'blue',
    };
  });
}

/** Cancela um desafio aberto e devolve a aposta do criador. */
export async function cancelChallenge({ code, userId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM challenges WHERE code = $1 FOR UPDATE`, [code]);
    const challenge = rows[0];
    if (!challenge) throw notFound('Desafio não encontrado.');
    if (challenge.creator_id !== userId) throw forbidden('Só quem criou pode cancelar.');
    if (challenge.status !== 'open') throw conflict('Só um desafio ainda aberto pode ser cancelado.');

    await refundStakes(client, challenge, 'Desafio cancelado pelo criador');
    await client.query(`UPDATE challenges SET status = 'cancelled' WHERE id = $1`, [challenge.id]);
    return { code, status: 'cancelled' };
  });
}

/** Devolve as apostas travadas. Usado em cancelamento, expiração e anulação. */
async function refundStakes(client, challenge, memo) {
  if (challenge.stake_cents <= 0) return;
  const escrowId = await ledger.systemAccountId(client, 'escrow');

  for (const [side, userId] of [['creator', challenge.creator_id], ['opponent', challenge.opponent_id]]) {
    if (!userId) continue;
    // Só devolve o que de fato foi travado.
    const { rows } = await client.query(
      `SELECT 1 FROM ledger_transactions WHERE idempotency_key = $1`,
      [`stake:${challenge.id}:${side}`],
    );
    if (!rows[0]) continue;

    const walletId = await ledger.ensureUserAccount(client, userId);
    await ledger.transfer(client, {
      fromAccountId: escrowId,
      toAccountId: walletId,
      amountCents: challenge.stake_cents,
      reason: 'stake_refund',
      idempotencyKey: `stake-refund:${challenge.id}:${side}`,
      referenceType: 'challenge',
      referenceId: challenge.id,
      memo,
    });
  }
}

/**
 * Liquida o desafio e paga o prêmio.
 *
 * Chamado SÓ pelo módulo de partidas, depois de o motor de regras ter
 * declarado o vencedor e de o `replay()` ter confirmado o log.
 */
export async function settleChallenge(client, { challengeId, winnerUserId }) {
  const { rows } = await client.query(
    `SELECT * FROM challenges WHERE id = $1 FOR UPDATE`,
    [challengeId],
  );
  const challenge = rows[0];
  if (!challenge) throw notFound('Desafio não encontrado.');

  // Idempotente: se já liquidou, não paga de novo.
  if (challenge.status === 'settled') {
    return { alreadySettled: true, winnerId: challenge.winner_id };
  }
  if (!['playing', 'staked'].includes(challenge.status)) {
    throw conflict(`Desafio em ${challenge.status} não pode ser liquidado.`);
  }
  if (![challenge.creator_id, challenge.opponent_id].includes(winnerUserId)) {
    throw new Error('Vencedor não participa deste desafio.');
  }

  let payoutTxId = null;
  if (challenge.stake_cents > 0) {
    const potCents = challenge.stake_cents * 2;
    const { prizeCents, commissionCents } = splitPot(potCents, challenge.commission_bps);

    const escrowId = await ledger.systemAccountId(client, 'escrow');
    const houseId = await ledger.systemAccountId(client, 'house_revenue');
    const winnerWalletId = await ledger.ensureUserAccount(client, winnerUserId);

    // Um único lançamento com três pernas: o pote sai do escrow e se divide
    // entre o vencedor e a casa. Soma zero, tudo ou nada.
    const entries = [{ accountId: escrowId, amountCents: -potCents }];
    if (prizeCents > 0) entries.push({ accountId: winnerWalletId, amountCents: prizeCents });
    if (commissionCents > 0) entries.push({ accountId: houseId, amountCents: commissionCents });

    const result = await ledger.post(client, {
      reason: 'prize_payout',
      idempotencyKey: `payout:${challenge.id}`,
      entries,
      referenceType: 'challenge',
      referenceId: challenge.id,
      memo: `Prêmio de desafio — pote ${formatBRL(potCents)}, comissão ${formatBRL(commissionCents)}`,
    });
    payoutTxId = result.transactionId;
  }

  await client.query(
    `UPDATE challenges SET status = 'settled', winner_id = $2, payout_tx_id = $3, settled_at = now()
      WHERE id = $1`,
    [challenge.id, winnerUserId, payoutTxId],
  );

  await client.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
     VALUES (NULL, 'challenge.settled', 'challenge', $1, $2)`,
    [challenge.id, JSON.stringify({ winnerUserId, stakeCents: challenge.stake_cents })],
  );

  const pot = challenge.stake_cents * 2;
  const split = splitPot(pot, challenge.commission_bps);
  return { alreadySettled: false, winnerId: winnerUserId, potCents: pot, ...split };
}

/**
 * Anula o desafio e devolve as apostas.
 * Usado quando algo não fecha — log inconsistente, erro do servidor. Na
 * dúvida, o dinheiro volta para os jogadores; a casa fica com o prejuízo
 * do erro, não eles.
 */
export async function voidChallenge(client, { challengeId, reason }) {
  const { rows } = await client.query(`SELECT * FROM challenges WHERE id = $1 FOR UPDATE`, [challengeId]);
  const challenge = rows[0];
  if (!challenge) throw notFound('Desafio não encontrado.');
  if (challenge.status === 'voided') return { alreadyVoided: true };
  if (challenge.status === 'settled') throw conflict('Desafio já liquidado.');

  await refundStakes(client, challenge, `Desafio anulado: ${String(reason).slice(0, 150)}`);
  await client.query(`UPDATE challenges SET status = 'voided', settled_at = now() WHERE id = $1`, [challenge.id]);
  await client.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
     VALUES (NULL, 'challenge.voided', 'challenge', $1, $2)`,
    [challenge.id, JSON.stringify({ reason })],
  );
  return { alreadyVoided: false };
}

/** Expira desafios abertos que ninguém aceitou e devolve as apostas. */
export async function expireStaleChallenges() {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM challenges WHERE status = 'open' AND expires_at < now() FOR UPDATE SKIP LOCKED`,
    );
    for (const challenge of rows) {
      await refundStakes(client, challenge, 'Desafio expirou sem adversário');
      await client.query(`UPDATE challenges SET status = 'expired' WHERE id = $1`, [challenge.id]);
    }
    return rows.length;
  });
}

export async function getChallengeByCode(client, code, userId) {
  const { rows } = await client.query(
    `SELECT c.*, m.id AS match_id, m.status AS match_status, m.server_seed_hash,
            m.color_by_user, m.winner_color,
            cu.display_name AS creator_name, ou.display_name AS opponent_name
       FROM challenges c
       LEFT JOIN matches m ON m.challenge_id = c.id
       LEFT JOIN users cu ON cu.id = c.creator_id
       LEFT JOIN users ou ON ou.id = c.opponent_id
      WHERE c.code = $1`,
    [code],
  );
  const c = rows[0];
  if (!c) throw notFound('Desafio não encontrado.');
  const isParticipant = userId && [c.creator_id, c.opponent_id].includes(userId);
  return { ...c, isParticipant };
}

export async function listMyChallenges(client, userId, limit = 20) {
  const { rows } = await client.query(
    `SELECT c.id, c.code, c.stake_cents, c.status, c.winner_id, c.created_at, c.settled_at,
            c.creator_id, c.opponent_id
       FROM challenges c
      WHERE c.creator_id = $1 OR c.opponent_id = $1
      ORDER BY c.created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 100)],
  );
  return rows;
}
