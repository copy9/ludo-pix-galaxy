/* Desafios e partidas valendo dinheiro.
 *
 * Fluxo do dinheiro, sempre pelo razao de partidas dobradas:
 *
 *   criar/aceitar  user:A  -aposta  ->  escrow:<code>  +aposta
 *                  user:B  -aposta  ->  escrow:<code>  +aposta
 *   resolver       escrow:<code>  -pote  ->  user:vencedor +premio
 *                                        ->  house:rake    +comissao
 *   cancelar       escrow:<code>  -pote  ->  devolve a cada um o que apostou
 *
 * O escrow zera ao fim dos dois caminhos. Se nao zerar, auditIntegrity() acusa.
 */
import { db, audit } from './db.js';
import {
  postTransaction, userAccount, escrowAccount, balanceOf,
  HOUSE_RAKE, splitPot,
} from './money.js';
import * as Ludo from './ludo.js';
import { randomBytes, createHmac, randomUUID } from 'node:crypto';

const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_STAKE_CENTS = 100;         // R$ 1,00
export const MAX_STAKE_CENTS = 500000;      // R$ 5.000,00

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem I/O/0/1

function newCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const b = randomBytes(8);
    const code = Array.from(b.slice(0, 6), (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
    if (!db.prepare('SELECT 1 FROM challenges WHERE code = ?').get(code)) return code;
  }
  throw new Error('nao consegui gerar codigo unico');
}

/* ---------------------------------------------------------------- dado
 * Provably fair: o servidor sorteia uma semente secreta por partida e so publica
 * o hash dela no inicio. Cada rolagem e HMAC(semente, codigo:nonce). No fim da
 * partida a semente e revelada, e o jogador pode recalcular todas as rolagens e
 * conferir que batem com o hash publicado antes.
 *
 * Isso resolve o problema inverso do dado no navegador: la o jogador trapaceava;
 * aqui o jogador precisa poder confiar em NOS. O hash publicado antes e a prova.
 */
export function rollDie(serverSeed, code, nonce) {
  const mac = createHmac('sha256', serverSeed).update(`${code}:${nonce}`).digest();
  // Rejeicao de amostra: 256 nao e multiplo de 6; usar o resto direto daria
  // vantagem aos valores 1..4. Percorremos os bytes ate achar um abaixo de 252.
  for (const byte of mac) if (byte < 252) return (byte % 6) + 1;
  return (mac[mac.length - 1] % 6) + 1;   // praticamente inalcancavel
}

/* ------------------------------------------------------------ desafios */

export const createChallenge = db.transaction(({ userId, stakeCents, rakeBps = 2000 }) => {
  if (!Number.isSafeInteger(stakeCents) || stakeCents < 0)
    throw Object.assign(new Error('valor invalido'), { code: 'BAD_STAKE' });
  if (stakeCents > 0 && (stakeCents < MIN_STAKE_CENTS || stakeCents > MAX_STAKE_CENTS))
    throw Object.assign(new Error('valor fora dos limites'), { code: 'BAD_STAKE' });

  const code = newCode();
  const now = Date.now();
  db.prepare(`INSERT INTO challenges
    (code,creator_id,stake_cents,rake_bps,status,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(code, userId, stakeCents, rakeBps, 'waiting', now, now + CHALLENGE_TTL_MS);

  if (stakeCents > 0) {
    // A aposta sai da carteira AGORA e fica presa no escrow. Se o saldo nao
    // cobrir, postTransaction aborta e o desafio inteiro some junto (rollback).
    postTransaction({
      kind: 'stake',
      idempotencyKey: `stake:${code}:${userId}`,
      memo: `aposta no desafio ${code}`,
      entries: [
        { account: userAccount(userId), amount_cents: -stakeCents },
        { account: escrowAccount(code), amount_cents: +stakeCents },
      ],
    });
  }
  audit(userId, 'challenge.created', { code, stakeCents });
  return db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
});

export const acceptChallenge = db.transaction(({ code, userId }) => {
  const ch = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
  if (!ch) throw Object.assign(new Error('desafio nao encontrado'), { code: 'NOT_FOUND' });
  if (ch.status !== 'waiting')
    throw Object.assign(new Error('desafio nao esta aberto'), { code: 'NOT_OPEN' });
  if (ch.creator_id === userId)
    throw Object.assign(new Error('nao da para aceitar o proprio desafio'), { code: 'SELF_ACCEPT' });
  if (ch.expires_at < Date.now())
    throw Object.assign(new Error('desafio expirado'), { code: 'EXPIRED' });

  if (ch.stake_cents > 0) {
    postTransaction({
      kind: 'stake',
      idempotencyKey: `stake:${code}:${userId}`,
      memo: `aposta no desafio ${code}`,
      entries: [
        { account: userAccount(userId), amount_cents: -ch.stake_cents },
        { account: escrowAccount(code), amount_cents: +ch.stake_cents },
      ],
    });
  }

  db.prepare(`UPDATE challenges SET opponent_id = ?, status = 'both_staked' WHERE code = ?`)
    .run(userId, code);

  // Semente secreta da partida. So o hash vai para os jogadores agora.
  const serverSeed = randomBytes(32).toString('hex');
  const state = Ludo.newGame(['red', 'blue']);   // criador = red, convidado = blue
  db.prepare(`INSERT INTO matches (code,state_json,version,updated_at) VALUES (?,?,?,?)`)
    .run(code, JSON.stringify({ ...state, serverSeed, nonce: 0 }), 0, Date.now());

  audit(userId, 'challenge.accepted', { code });
  return db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
});

/** Cancelar devolve a aposta de quem ja pagou. So antes de o adversario entrar. */
export const cancelChallenge = db.transaction(({ code, userId }) => {
  const ch = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
  if (!ch) throw Object.assign(new Error('desafio nao encontrado'), { code: 'NOT_FOUND' });
  if (ch.creator_id !== userId)
    throw Object.assign(new Error('so quem criou pode cancelar'), { code: 'FORBIDDEN' });
  if (ch.status !== 'waiting')
    throw Object.assign(new Error('a partida ja comecou'), { code: 'NOT_OPEN' });

  if (ch.stake_cents > 0) {
    postTransaction({
      kind: 'refund',
      idempotencyKey: `refund:${code}:${userId}`,
      memo: `devolucao do desafio ${code}`,
      entries: [
        { account: escrowAccount(code), amount_cents: -ch.stake_cents },
        { account: userAccount(userId), amount_cents: +ch.stake_cents },
      ],
    });
  }
  db.prepare(`UPDATE challenges SET status='cancelled', resolved_at=? WHERE code=?`)
    .run(Date.now(), code);
  audit(userId, 'challenge.cancelled', { code });
  return { ok: true };
});

/* ------------------------------------------------------------- partida */

const loadMatch = (code) => {
  const row = db.prepare('SELECT * FROM matches WHERE code = ?').get(code);
  return row ? { ...row, state: JSON.parse(row.state_json) } : null;
};

/** Cor do jogador nesta partida, ou null se ele nao faz parte dela. */
export function colorOf(ch, userId) {
  if (ch.creator_id === userId) return 'red';
  if (ch.opponent_id === userId) return 'blue';
  return null;
}

/** O que o cliente pode ver. A semente fica escondida ate a partida acabar. */
export function publicState(ch, m, userId) {
  const { serverSeed, nonce, ...visible } = m.state;
  return {
    code: ch.code,
    status: ch.status,
    stakeCents: ch.stake_cents,
    rakeBps: ch.rake_bps,
    yourColor: colorOf(ch, userId),
    version: m.version,
    game: visible,
    // Compromisso publicado ANTES das rolagens; a semente e revelada ao fim.
    seedHash: createHmac('sha256', 'commit').update(serverSeed).digest('hex'),
    serverSeed: ch.status === 'resolved' ? serverSeed : undefined,
    legalMoves: visible.dice == null ? []
      : Ludo.legalMoves(visible, visible.players[visible.curIdx], visible.dice),
  };
}

export const rollDice = db.transaction(({ code, userId, version }) => {
  const ch = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
  const m = loadMatch(code);
  if (!ch || !m) throw Object.assign(new Error('partida nao encontrada'), { code: 'NOT_FOUND' });

  const color = colorOf(ch, userId);
  if (!color) throw Object.assign(new Error('voce nao esta nesta partida'), { code: 'FORBIDDEN' });
  if (ch.status !== 'both_staked')
    throw Object.assign(new Error('partida nao esta em andamento'), { code: 'NOT_PLAYING' });

  /* Trava otimista ANTES da checagem de vez.
     Um pedido construido sobre um estado velho tem de receber STALE ("recarregue"),
     nao NOT_YOUR_TURN — que e o que aconteceria quando a rolagem anterior passou a
     vez, e confundiria o cliente sobre o que de fato houve.
     Isto e o que impede dois POST /roll da mesma aba (clique duplo, retry de rede)
     virarem duas rolagens. */
  const st = m.state;
  if (version !== undefined && version !== m.version)
    throw Object.assign(new Error('estado desatualizado'), { code: 'STALE' });
  if (st.players[st.curIdx].color !== color)
    throw Object.assign(new Error('nao e a sua vez'), { code: 'NOT_YOUR_TURN' });

  const nonce = st.nonce + 1;
  const value = rollDie(st.serverSeed, code, nonce);
  const { state: next } = Ludo.setDice(st, value);
  next.serverSeed = st.serverSeed;
  next.nonce = nonce;

  db.prepare('INSERT INTO dice_rolls (code,user_id,value,server_seed,nonce,created_at) VALUES (?,?,?,?,?,?)')
    .run(code, userId, value, st.serverSeed, nonce, Date.now());
  db.prepare('UPDATE matches SET state_json=?, version=version+1, updated_at=? WHERE code=?')
    .run(JSON.stringify(next), Date.now(), code);

  return { value, state: publicState(ch, loadMatch(code), userId) };
});

export const makeMove = db.transaction(({ code, userId, tokenIdx, version }) => {
  const ch = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
  const m = loadMatch(code);
  if (!ch || !m) throw Object.assign(new Error('partida nao encontrada'), { code: 'NOT_FOUND' });

  const color = colorOf(ch, userId);
  if (!color) throw Object.assign(new Error('voce nao esta nesta partida'), { code: 'FORBIDDEN' });
  if (ch.status !== 'both_staked')
    throw Object.assign(new Error('partida nao esta em andamento'), { code: 'NOT_PLAYING' });

  const st = m.state;
  if (version !== undefined && version !== m.version)
    throw Object.assign(new Error('estado desatualizado'), { code: 'STALE' });
  if (st.players[st.curIdx].color !== color)
    throw Object.assign(new Error('nao e a sua vez'), { code: 'NOT_YOUR_TURN' });

  // Ludo.applyMove rejeita jogada ilegal. O cliente nao tem como forcar.
  const { state: next, captured, reachedHome } = Ludo.applyMove(st, tokenIdx);
  next.serverSeed = st.serverSeed;
  next.nonce = st.nonce;

  db.prepare('UPDATE matches SET state_json=?, version=version+1, updated_at=? WHERE code=?')
    .run(JSON.stringify(next), Date.now(), code);

  // Fim de jogo: a liquidacao acontece aqui, no mesmo passo, sem o cliente pedir.
  if (next.gameOver) settle({ code, winnerColor: next.winnerColor });

  return {
    captured, reachedHome,
    state: publicState(
      db.prepare('SELECT * FROM challenges WHERE code = ?').get(code),
      loadMatch(code), userId),
  };
});

/**
 * Paga o vencedor e a comissao, esvaziando o escrow.
 * Nao e exportado para rota nenhuma: so o fim de partida chama.
 */
const settle = db.transaction(({ code, winnerColor, motivo = null }) => {
  const ch = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
  if (!ch || ch.status === 'resolved') return;

  const winnerId = winnerColor === 'red' ? ch.creator_id : ch.opponent_id;
  const pot = balanceOf(escrowAccount(code));

  if (pot > 0) {
    const { winnerCents, rakeCents } = splitPot(pot, ch.rake_bps);
    const entries = [
      { account: escrowAccount(code), amount_cents: -pot },
      { account: userAccount(winnerId), amount_cents: +winnerCents },
    ];
    // splitPot arredonda a comissao para baixo, entao o resto vai para a casa e
    // o escrow fecha exatamente em zero.
    if (rakeCents > 0) entries.push({ account: HOUSE_RAKE, amount_cents: +rakeCents });
    postTransaction({
      kind: 'payout',
      idempotencyKey: `payout:${code}`,   // pagar duas vezes e impossivel
      memo: motivo ? `premio do desafio ${code} (${motivo})` : `premio do desafio ${code}`,
      entries,
    });
  }

  db.prepare(`UPDATE challenges SET status='resolved', winner_id=?, resolved_at=? WHERE code=?`)
    .run(winnerId, Date.now(), code);

  /* Marca o fim tambem no estado da partida: sem isto, quem reabrir a pagina
     depois de um W.O. veria uma partida eternamente "em andamento". */
  const m = loadMatch(code);
  if (m && !m.state.gameOver) {
    const fim = { ...m.state, gameOver: true, winnerColor, dice: null, endedBy: motivo };
    db.prepare('UPDATE matches SET state_json=?, version=version+1, updated_at=? WHERE code=?')
      .run(JSON.stringify(fim), Date.now(), code);
  }
  audit(winnerId, 'challenge.resolved', { code, pot, motivo });
});

/** Desafio aberto que ninguem aceitou: devolve a aposta de quem criou. */
export const expireStale = db.transaction(() => {
  const now = Date.now();
  const stale = db.prepare(`SELECT * FROM challenges WHERE status='waiting' AND expires_at < ?`).all(now);
  for (const ch of stale) {
    if (ch.stake_cents > 0) {
      postTransaction({
        kind: 'refund',
        idempotencyKey: `refund:${ch.code}:${ch.creator_id}`,
        memo: `desafio ${ch.code} expirou`,
        entries: [
          { account: escrowAccount(ch.code), amount_cents: -ch.stake_cents },
          { account: userAccount(ch.creator_id), amount_cents: +ch.stake_cents },
        ],
      });
    }
    db.prepare(`UPDATE challenges SET status='expired', resolved_at=? WHERE code=?`).run(now, ch.code);
  }
  return stale.length;
});

/* ----------------------------------------------- partida abandonada
 *
 * Sem isto, o escrow de uma partida comecada so esvaziava quando ela TERMINAVA.
 * Jogador que fecha o navegador no meio deixava as duas apostas presas para
 * sempre: cancelar e recusado porque a partida ja comecou, e expireStale so
 * olha desafio que ninguem aceitou.
 *
 * Pior que o dinheiro parado era o incentivo: quem estava perdendo ganhava
 * motivo para sumir — "se eu nao posso ganhar, ninguem saca".
 *
 * Regra adotada:
 *   - ninguem jogou nada ainda  -> devolve a aposta aos dois (ninguem se
 *     comprometeu, e cobrar comissao de uma partida que nao aconteceu e roubo);
 *   - a partida andou e parou   -> quem tinha a vez perde por W.O., e o premio
 *     sai normalmente, com comissao. Abandonar passa a custar a aposta.
 */
export const MATCH_IDLE_MS = Number(process.env.MATCH_IDLE_MS) || 15 * 60 * 1000;

export const forfeitIdle = db.transaction(() => {
  const limite = Date.now() - MATCH_IDLE_MS;
  const paradas = db.prepare(`
    SELECT c.*, m.state_json, m.updated_at
    FROM challenges c JOIN matches m ON m.code = c.code
    WHERE c.status = 'both_staked' AND m.updated_at < ?`).all(limite);

  let encerradas = 0;
  for (const row of paradas) {
    const st = JSON.parse(row.state_json);
    const comecou = (st.nonce || 0) > 0;

    if (!comecou) {
      // Ninguem rolou o dado sequer: devolve integralmente aos dois.
      for (const uid of [row.creator_id, row.opponent_id]) {
        if (!uid || row.stake_cents <= 0) continue;
        postTransaction({
          kind: 'refund',
          idempotencyKey: `refund-idle:${row.code}:${uid}`,
          memo: `partida ${row.code} abandonada antes de comecar`,
          entries: [
            { account: escrowAccount(row.code), amount_cents: -row.stake_cents },
            { account: userAccount(uid), amount_cents: +row.stake_cents },
          ],
        });
      }
      db.prepare(`UPDATE challenges SET status='cancelled', resolved_at=? WHERE code=?`)
        .run(Date.now(), row.code);
      audit(null, 'match.abandoned_before_start', { code: row.code });
    } else {
      // Quem tinha a vez e nao jogou perde por W.O.
      const corDaVez = st.players[st.curIdx].color;
      const vencedor = corDaVez === 'red' ? 'blue' : 'red';
      settle({ code: row.code, winnerColor: vencedor, motivo: 'W.O. por inatividade' });
      audit(null, 'match.forfeit', { code: row.code, abandonou: corDaVez });
    }
    encerradas++;
  }
  return encerradas;
});

/** Desistir na hora, sem esperar o timeout. O adversario vence. */
export const forfeit = db.transaction(({ code, userId }) => {
  const ch = db.prepare('SELECT * FROM challenges WHERE code = ?').get(code);
  if (!ch) throw Object.assign(new Error('partida nao encontrada'), { code: 'NOT_FOUND' });
  const cor = colorOf(ch, userId);
  if (!cor) throw Object.assign(new Error('voce nao esta nesta partida'), { code: 'FORBIDDEN' });
  if (ch.status !== 'both_staked')
    throw Object.assign(new Error('partida nao esta em andamento'), { code: 'NOT_PLAYING' });

  settle({ code, winnerColor: cor === 'red' ? 'blue' : 'red', motivo: 'desistencia' });
  audit(userId, 'match.forfeit_voluntario', { code });
  return { ok: true };
});

export { loadMatch };
