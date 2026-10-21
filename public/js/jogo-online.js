/**
 * Modo aposta: o servidor é o árbitro.
 *
 * O que havia no protótipo: o navegador sorteava o dado, decidia a jogada e
 * empurrava o estado inteiro da partida para o banco com `matchDoc.update`.
 * Quem abrisse o console vencia. E o resultado era "reportado" por cada
 * jogador — com um bug que apagava o voto do adversário, de forma que um
 * desafio real entre duas pessoas nunca se resolvia e o dinheiro ficava preso.
 *
 * Agora o navegador faz dois pedidos — "quero lançar" e "quero mover a peça
 * N" — e desenha o que o servidor responder. Não escolhe o dado, não forja
 * jogada ilegal e não opina sobre quem venceu.
 *
 * Este módulo conversa com o resto de jogo.html pelo objeto `window.LudoView`,
 * que a página expõe com as funções de desenho.
 */

import { api, watchMatch, esc, formatBRL } from './api.js';

const V = window.LudoView;
const matchId = new URLSearchParams(location.search).get('match');

let myColor = null;
let stream = null;
let busy = false;

/** Traz o estado autoritativo do servidor para a tela. */
function adopt(state) {
  V.setState({
    players: state.players,
    turnIndex: state.turnIndex,
    die: state.die,
    gameOver: state.gameOver,
    ranking: state.ranking || [],
    teams: state.teams || null,
  });

  const myTurn = !state.gameOver && state.players[state.turnIndex].color === myColor;
  const movable = myTurn && state.die !== null ? state.legalMoves : null;

  V.renderTurnbar();
  V.renderTokens(movable && movable.length ? movable : null);
  V.setRollEnabled(myTurn && state.die === null);

  if (state.gameOver) V.toast('');
  else if (myTurn) {
    V.toast(state.die === null ? 'Sua vez! Role o dado.' : `Você tirou ${state.die} — escolha uma peça.`);
  } else {
    V.toast(`Vez de ${V.colorName(state.players[state.turnIndex].color)}…`);
  }
}

function showResult(settlement) {
  if (settlement?.voided) {
    V.showFinalOverlay('Partida anulada', 'Houve uma inconsistência e as apostas foram devolvidas.', myColor);
    V.hidePlayAgain();
    return;
  }
  const iWon = settlement?.winnerColor === myColor;
  let text = iWon ? 'Você levou as 4 peças para casa!' : 'Seu adversário venceu esta partida.';
  if (iWon && settlement?.prizeCents > 0) {
    text += ` Prêmio de ${formatBRL(settlement.prizeCents)} creditado na sua carteira.`;
  }
  V.showFinalOverlay(iWon ? '👑 Você venceu!' : 'Fim de jogo', text, settlement?.winnerColor ?? myColor);
  V.hidePlayAgain();
  if (settlement?.challengeCode) V.showBackToChallenge(settlement.challengeCode);
  if (settlement?.winnerColor) V.celebrate(settlement.winnerColor);
}

async function roll() {
  if (busy) return;
  busy = true;
  V.setRollEnabled(false);
  V.mascot('roll');
  try {
    const res = await api.roll(matchId);
    // A animação do cubo usa o valor que o SERVIDOR mandou.
    await V.animateDie(res.die);
    if (res.die === 6) V.mascot('cheer', 'Seis! 🎉');
    else if (!res.moves.length) V.mascot('shrug', 'Sem jogadas… 🤷');
    adopt(res.state);
  } catch (err) {
    V.toast(err.message);
    await refresh();
  } finally {
    busy = false;
  }
}

async function move(tokenIndex) {
  if (busy) return;
  busy = true;
  V.renderTokens(null);
  try {
    const res = await api.move(matchId, tokenIndex);
    V.animateMove(res.report);
    adopt(res.state);
    if (res.settlement) showResult(res.settlement);
  } catch (err) {
    V.toast(err.message);
    await refresh();
  } finally {
    busy = false;
  }
}

async function refresh() {
  try {
    const m = await api.getMatch(matchId);
    adopt(m.state);
  } catch { /* o stream reconecta sozinho */ }
}

export async function initOnlineMatch() {
  const setup = document.getElementById('setup');
  let match;
  try {
    match = await api.getMatch(matchId);
  } catch (err) {
    setup.innerHTML =
      `<p style="padding:20px;">${esc(err.message)}</p>` +
      (err.isAuth
        ? '<p style="padding:0 20px 20px;"><a href="perfil.html" style="color:#2de2ff;">Entrar na minha conta</a></p>'
        : '');
    setup.style.display = 'block';
    return;
  }

  myColor = match.myColor;
  V.enterOnlineMode({ myColor, onRoll: roll, onMove: move });
  adopt(match.state);

  if (match.status === 'finished') {
    showResult({ winnerColor: match.state.winnerColor, prizeCents: 0 });
  }

  // Tempo real: o servidor avisa quando o adversário joga.
  stream = watchMatch(matchId, {
    onState: (s) => { if (!busy) adopt(s); },
    onEnd: (settlement) => showResult(settlement),
  });
  window.addEventListener('beforeunload', () => stream?.close());
}
