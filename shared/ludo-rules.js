/**
 * Motor de regras do Ludo — módulo puro, sem DOM e sem rede.
 *
 * Este arquivo é a ÚNICA fonte de verdade das regras. O servidor o usa para
 * validar cada jogada e decidir o vencedor; o navegador usa o mesmo arquivo
 * apenas para desenhar e antecipar jogadas. Se os dois discordarem, o
 * servidor vence — o cliente nunca decide nada que valha dinheiro.
 *
 * Posição de uma peça (`pos`):
 *   -1       → no pátio (casa inicial), ainda não entrou
 *   0..50    → na pista comum; casa física = (entry[cor] + pos) % 52
 *   51..56   → no corredor final privado da cor; 56 é a chegada
 *
 * Funciona tanto em Node (ESM) quanto no navegador via <script type="module">.
 */

export const COLORS = ['red', 'green', 'yellow', 'blue'];

export const COLOR_NAMES = {
  red: 'Vermelho',
  green: 'Verde',
  yellow: 'Amarelo',
  blue: 'Azul',
};

/** Pista comum, 52 casas, em coordenadas [linha, coluna] de um tabuleiro 15x15. */
export const MASTER_PATH = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6],
  [0, 6], [0, 7], [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 9], [6, 10],
  [6, 11], [6, 12], [6, 13], [6, 14], [7, 14], [8, 14], [8, 13], [8, 12], [8, 11], [8, 10],
  [8, 9], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7], [14, 6], [13, 6],
  [12, 6], [11, 6], [10, 6], [9, 6], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  [7, 0], [6, 0],
];

/** Casa da pista comum onde cada cor entra (pos 0). */
export const ENTRY = { red: 0, green: 13, yellow: 26, blue: 39 };

/** Corredor final privado de cada cor (pos 51..56). */
export const HOME_STRETCH = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
};

/** Onde as peças ficam enquanto estão no pátio (pos -1). Só visual. */
export const YARD_SLOTS = {
  red: [[2, 2], [2, 3], [3, 2], [3, 3]],
  green: [[2, 11], [2, 12], [3, 11], [3, 12]],
  yellow: [[11, 11], [11, 12], [12, 11], [12, 12]],
  blue: [[11, 2], [11, 3], [12, 2], [12, 3]],
};

/** Casas da pista onde nenhuma peça pode ser capturada. */
export const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export const PATH_LENGTH = 52;
export const HOME_POS = 56;
export const TOKENS_PER_PLAYER = 4;

/** Casa física na pista comum ocupada por uma peça da cor `color` em `pos`. */
export function physicalCell(color, pos) {
  if (pos < 0 || pos > 50) return null;
  return (ENTRY[color] + pos) % PATH_LENGTH;
}

/** Coordenada [linha, coluna] de uma peça, ou null se estiver no pátio. */
export function coordFor(color, pos, tokenIndex = 0) {
  if (pos === -1) return YARD_SLOTS[color][tokenIndex] ?? null;
  if (pos <= 50) return MASTER_PATH[physicalCell(color, pos)];
  return HOME_STRETCH[color][pos - 51];
}

/** Dois jogadores são aliados se o modo duplas estiver ativo e compartilharem equipe. */
function sameTeam(state, colorA, colorB) {
  if (colorA === colorB) return true;
  if (!state.teams) return false;
  return state.teams[colorA] === state.teams[colorB];
}

/**
 * Uma casa está bloqueada se um adversário tiver duas ou mais peças nela.
 * O corredor final é privado, nunca bloqueia.
 */
export function isBlockedForLanding(state, player, newPos) {
  if (newPos > 50) return false;
  const target = physicalCell(player.color, newPos);
  const perColor = new Map();
  for (const other of state.players) {
    if (sameTeam(state, other.color, player.color)) continue;
    for (const pos of other.tokens) {
      if (physicalCell(other.color, pos) === target) {
        perColor.set(other.color, (perColor.get(other.color) || 0) + 1);
      }
    }
  }
  for (const count of perColor.values()) if (count >= 2) return true;
  return false;
}

/** Índices das peças que podem se mover com o dado `die`. */
export function legalMoves(state, player, die) {
  const moves = [];
  player.tokens.forEach((pos, index) => {
    if (pos === -1) {
      // Só se sai do pátio com 6.
      if (die === 6 && !isBlockedForLanding(state, player, 0)) moves.push(index);
    } else if (pos + die <= HOME_POS) {
      // A chegada exige número exato: pos + die não pode passar de 56.
      if (!isBlockedForLanding(state, player, pos + die)) moves.push(index);
    }
  });
  return moves;
}

/** Cria o estado inicial de uma partida. `teams` só é válido com 4 jogadores. */
export function createGame({ colors, teams = null }) {
  if (!Array.isArray(colors) || colors.length < 2 || colors.length > 4) {
    throw new Error('Uma partida tem de 2 a 4 jogadores.');
  }
  for (const c of colors) {
    if (!COLORS.includes(c)) throw new Error(`Cor inválida: ${c}`);
  }
  if (new Set(colors).size !== colors.length) throw new Error('Cores repetidas.');
  if (teams && colors.length !== 4) throw new Error('Duplas exigem 4 jogadores.');

  return {
    players: colors.map((color) => ({
      color,
      tokens: new Array(TOKENS_PER_PLAYER).fill(-1),
      finished: false,
    })),
    teams,
    turnIndex: 0,
    die: null,
    turnNumber: 0,
    ranking: [],
    gameOver: false,
    winnerColor: null,
    winnerTeam: null,
  };
}

export function currentPlayer(state) {
  return state.players[state.turnIndex];
}

/**
 * Registra o valor do dado no estado. O valor NUNCA é sorteado aqui — quem
 * sorteia é o servidor, com RNG criptográfico (ver server/src/lib/rng.js).
 */
export function applyRoll(state, die) {
  if (state.gameOver) throw new RuleError('A partida já terminou.');
  if (state.die !== null) throw new RuleError('O dado já foi lançado neste turno.');
  if (!Number.isInteger(die) || die < 1 || die > 6) throw new RuleError('Valor de dado inválido.');
  state.die = die;
  const moves = legalMoves(state, currentPlayer(state), die);
  return { die, moves };
}

export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
    this.isRuleError = true;
  }
}

/**
 * Executa o movimento da peça `tokenIndex` do jogador da vez.
 * Devolve um relatório do que aconteceu — é esse relatório que o servidor
 * grava no log da partida e envia aos dois jogadores.
 */
export function applyMove(state, tokenIndex) {
  if (state.gameOver) throw new RuleError('A partida já terminou.');
  if (state.die === null) throw new RuleError('Lance o dado antes de mover.');

  const player = currentPlayer(state);
  const die = state.die;
  const moves = legalMoves(state, player, die);
  if (!moves.includes(tokenIndex)) throw new RuleError('Jogada ilegal.');

  const from = player.tokens[tokenIndex];
  const to = from === -1 ? 0 : from + die;
  player.tokens[tokenIndex] = to;

  // ---- captura ----
  const captures = [];
  if (to <= 50 && !SAFE_CELLS.has(physicalCell(player.color, to))) {
    const target = physicalCell(player.color, to);
    for (const other of state.players) {
      if (sameTeam(state, other.color, player.color)) continue;
      other.tokens.forEach((pos, i) => {
        if (physicalCell(other.color, pos) === target) {
          other.tokens[i] = -1;
          captures.push({ color: other.color, tokenIndex: i });
        }
      });
    }
  }

  const reachedHome = to === HOME_POS;
  const justFinished = player.tokens.every((t) => t === HOME_POS);

  if (justFinished && !player.finished) {
    player.finished = true;
    state.ranking.push({ color: player.color, place: state.ranking.length + 1 });
  }

  const report = {
    color: player.color,
    tokenIndex,
    from,
    to,
    die,
    captures,
    reachedHome,
    finished: justFinished,
    extraTurn: false,
    gameOver: false,
  };

  // ---- fim de jogo ----
  if (state.teams && justFinished) {
    const mate = state.players.find(
      (p) => p.color !== player.color && state.teams[p.color] === state.teams[player.color],
    );
    if (mate && mate.finished) {
      finish(state, player.color);
      report.gameOver = true;
      return report;
    }
  }

  const remaining = state.players.filter((p) => !p.finished);
  if (remaining.length <= 1) {
    if (remaining.length === 1) {
      remaining[0].finished = true;
      state.ranking.push({ color: remaining[0].color, place: state.ranking.length + 1 });
    }
    finish(state, state.ranking[0].color);
    report.gameOver = true;
    return report;
  }

  // Jogar de novo: tirou 6, capturou, ou levou uma peça à chegada.
  const extra = die === 6 || captures.length > 0 || reachedHome;
  report.extraTurn = extra && !justFinished;
  advanceTurn(state, report.extraTurn);
  return report;
}

/** Turno sem jogada possível: passa a vez (6 ainda dá direito a novo lance). */
export function applyNoMove(state) {
  if (state.gameOver) throw new RuleError('A partida já terminou.');
  if (state.die === null) throw new RuleError('Lance o dado antes de passar.');
  const player = currentPlayer(state);
  if (legalMoves(state, player, state.die).length > 0) {
    throw new RuleError('Ainda existe jogada possível.');
  }
  const extra = state.die === 6;
  advanceTurn(state, extra);
  return { color: player.color, die: state.die, extraTurn: extra, noMove: true };
}

function advanceTurn(state, extraTurn) {
  state.die = null;
  state.turnNumber += 1;
  if (!extraTurn) {
    let guard = 0;
    do {
      state.turnIndex = (state.turnIndex + 1) % state.players.length;
      guard += 1;
    } while (state.players[state.turnIndex].finished && guard <= state.players.length);
  }
}

function finish(state, winnerColor) {
  state.gameOver = true;
  state.die = null;
  state.winnerColor = winnerColor;
  state.winnerTeam = state.teams ? state.teams[winnerColor] : null;
  for (const p of state.players) p.finished = true;
}

/**
 * Verificação independente: recalcula a partida inteira a partir do log de
 * eventos e confere que o estado final bate. O servidor roda isso antes de
 * pagar qualquer prêmio — se não bater, o pagamento não sai e o caso vai
 * para revisão manual.
 */
export function replay({ colors, teams = null }, events) {
  const state = createGame({ colors, teams });
  for (const ev of events) {
    if (ev.type === 'roll') applyRoll(state, ev.die);
    else if (ev.type === 'move') applyMove(state, ev.tokenIndex);
    else if (ev.type === 'no_move') applyNoMove(state);
    else throw new RuleError(`Evento desconhecido: ${ev.type}`);
  }
  return state;
}
