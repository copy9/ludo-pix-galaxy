/* Regras do Ludo — versao autoritativa.
 *
 * Em partida valendo dinheiro, TODA jogada passa por aqui antes de virar estado.
 * O navegador nao decide nada: ele pede "rolar" e "mover a peca N", e o servidor
 * responde com o estado novo. Isso e o que impede o jogador de abrir o console e
 * se declarar vencedor.
 *
 * O jogo.html tem uma copia destas regras para o modo livre (offline, sem
 * aposta), onde trapacear so prejudica o proprio jogador. Quando houver aposta,
 * quem vale e este arquivo.
 *
 * Mapa de posicoes de uma peca:
 *   -1       no curral (ainda nao entrou)
 *   0..50    trilha comum, 51 casas a partir da entrada da propria cor
 *   51..56   corredor de chegada, 6 casas (privativo)
 *   56       chegou em casa
 */

/** 52 casas da trilha comum, em coordenadas [linha, coluna] do tabuleiro 15x15. */
export const MASTER_PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],
  [14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],
  [8,1],[8,0],[7,0],[6,0],
];

export const COLORS = ['red', 'green', 'yellow', 'blue'];
export const ENTRY  = { red: 0, green: 13, yellow: 26, blue: 39 };
/** Entradas e estrelas: peca parada aqui nao pode ser capturada. */
export const SAFE_IDX = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
export const HOME = 56;
export const LAST_TRACK = 50;

if (MASTER_PATH.length !== 52) throw new Error('trilha precisa ter 52 casas');

/** Indice absoluto na trilha comum para uma peca de `color` na posicao `pos`. */
export function physIndex(color, pos) {
  if (pos < 0 || pos > LAST_TRACK) return null;   // curral ou corredor: fora da trilha
  return (ENTRY[color] + pos) % 52;
}

export function newGame(colors) {
  return {
    players: colors.map((c) => ({ color: c, tokens: [-1, -1, -1, -1], finished: false })),
    curIdx: 0,
    dice: null,
    gameOver: false,
    winnerColor: null,
    ranking: [],
  };
}

/** Pecas de outras cores paradas na mesma casa fisica. */
function occupantsAt(state, physIdx) {
  const counts = {};
  for (const p of state.players) {
    for (const pos of p.tokens) {
      if (physIndex(p.color, pos) === physIdx) counts[p.color] = (counts[p.color] || 0) + 1;
    }
  }
  return counts;
}

/** Duas ou mais pecas inimigas na mesma casa formam bloqueio: ninguem pousa ali. */
export function isBlockedForLanding(state, player, newPos) {
  if (newPos > LAST_TRACK) return false;          // corredor de chegada e privativo
  const phys = physIndex(player.color, newPos);
  const counts = occupantsAt(state, phys);
  delete counts[player.color];
  return Object.values(counts).some((n) => n >= 2);
}

export function legalMoves(state, player, dice) {
  const out = [];
  player.tokens.forEach((pos, i) => {
    if (pos === -1) {
      if (dice === 6 && !isBlockedForLanding(state, player, 0)) out.push(i);
    } else if (pos < HOME && pos + dice <= HOME) {
      // Passar de 56 nao vale: a peca precisa do numero exato para entrar em casa.
      if (!isBlockedForLanding(state, player, pos + dice)) out.push(i);
    }
  });
  return out;
}

/**
 * Aplica uma jogada. Devolve estado NOVO (nao muta o recebido) ou lanca erro se
 * a jogada for ilegal — qualquer tentativa de jogada invalida vinda do cliente
 * morre aqui.
 */
export function applyMove(state, tokenIdx) {
  if (state.gameOver) throw Object.assign(new Error('partida encerrada'), { code: 'GAME_OVER' });
  if (state.dice == null) throw Object.assign(new Error('role o dado antes'), { code: 'NO_DICE' });

  const s = structuredClone(state);
  const p = s.players[s.curIdx];
  if (!legalMoves(s, p, s.dice).includes(tokenIdx))
    throw Object.assign(new Error('jogada ilegal'), { code: 'ILLEGAL_MOVE' });

  const oldPos = p.tokens[tokenIdx];
  const newPos = oldPos === -1 ? 0 : oldPos + s.dice;
  p.tokens[tokenIdx] = newPos;

  // Captura: so ao POUSAR, so fora das casas seguras, so em peca adversaria.
  let captured = false;
  const phys = physIndex(p.color, newPos);
  if (phys !== null && !SAFE_IDX.has(phys)) {
    for (const op of s.players) {
      if (op === p) continue;
      op.tokens.forEach((opos, oi) => {
        if (physIndex(op.color, opos) === phys) { op.tokens[oi] = -1; captured = true; }
      });
    }
  }

  const reachedHome = newPos === HOME;
  const justFinished = p.tokens.every((t) => t === HOME);
  if (justFinished && !p.finished) {
    p.finished = true;
    s.ranking.push(p.color);
  }

  const remaining = s.players.filter((pl) => !pl.finished);
  if (remaining.length <= 1) {
    if (remaining.length === 1) { remaining[0].finished = true; s.ranking.push(remaining[0].color); }
    s.gameOver = true;
    s.winnerColor = s.ranking[0] || null;
    s.dice = null;
    return { state: s, captured, reachedHome, extraTurn: false };
  }

  // Seis, captura ou chegada em casa dao direito a jogar de novo.
  const extraTurn = s.dice === 6 || captured || reachedHome;
  s.dice = null;
  if (!extraTurn) s.curIdx = nextActive(s, s.curIdx);
  return { state: s, captured, reachedHome, extraTurn };
}

function nextActive(s, from) {
  let i = from;
  for (let guard = 0; guard < s.players.length; guard++) {
    i = (i + 1) % s.players.length;
    if (!s.players[i].finished) return i;
  }
  return from;
}

/** Guarda o dado no estado. O VALOR vem de fora (ver rollDie em match.js). */
export function setDice(state, value) {
  if (state.gameOver) throw Object.assign(new Error('partida encerrada'), { code: 'GAME_OVER' });
  if (state.dice != null) throw Object.assign(new Error('dado ja rolado'), { code: 'ALREADY_ROLLED' });
  const s = structuredClone(state);
  s.dice = value;
  const p = s.players[s.curIdx];
  const moves = legalMoves(s, p, value);
  if (moves.length === 0) {
    // Sem jogada possivel: tirar 6 ainda da outra chance, qualquer outro valor passa a vez.
    s.dice = null;
    if (value !== 6) s.curIdx = nextActive(s, s.curIdx);
    return { state: s, moves: [], passed: true };
  }
  return { state: s, moves, passed: false };
}
