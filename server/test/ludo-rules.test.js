import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  legalMoves,
  applyRoll,
  applyMove,
  applyNoMove,
  currentPlayer,
  physicalCell,
  isBlockedForLanding,
  replay,
  RuleError,
  HOME_POS,
  MASTER_PATH,
  SAFE_CELLS,
} from '../../shared/ludo-rules.js';

const twoPlayer = () => createGame({ colors: ['red', 'blue'] });

test('o tabuleiro tem 52 casas únicas na pista comum', () => {
  assert.equal(MASTER_PATH.length, 52);
  const unique = new Set(MASTER_PATH.map((c) => c.join(',')));
  assert.equal(unique.size, 52);
});

test('as entradas das quatro cores caem em casas seguras', () => {
  for (const color of ['red', 'green', 'yellow', 'blue']) {
    assert.ok(SAFE_CELLS.has(physicalCell(color, 0)), `entrada de ${color} deveria ser segura`);
  }
});

test('só se sai do pátio com 6', () => {
  const g = twoPlayer();
  for (let die = 1; die <= 5; die += 1) {
    assert.deepEqual(legalMoves(g, currentPlayer(g), die), []);
  }
  assert.deepEqual(legalMoves(g, currentPlayer(g), 6), [0, 1, 2, 3]);
});

test('sem jogada possível o turno passa, mas o 6 dá novo lance', () => {
  const g = twoPlayer();
  applyRoll(g, 3);
  const r = applyNoMove(g);
  assert.equal(r.extraTurn, false);
  assert.equal(currentPlayer(g).color, 'blue');

  applyRoll(g, 6);
  assert.throws(() => applyNoMove(g), RuleError, 'com 6 no pátio existe jogada, não pode passar');
});

test('a chegada exige número exato', () => {
  const g = twoPlayer();
  g.players[0].tokens = [54, -1, -1, -1];
  assert.deepEqual(legalMoves(g, g.players[0], 2), [0], '54 + 2 = 56 chega');
  assert.deepEqual(legalMoves(g, g.players[0], 3), [], '54 + 3 = 57 passa da chegada');
});

test('captura manda a peça adversária de volta ao pátio e dá turno extra', () => {
  const g = twoPlayer();
  // red em pos 10 (casa física 10); blue precisa pousar na mesma casa física.
  g.players[1].tokens = [(10 - 39 + 52) % 52, -1, -1, -1];
  g.players[0].tokens = [7, -1, -1, -1];
  assert.equal(physicalCell('red', 10), 10);
  assert.equal(physicalCell('blue', g.players[1].tokens[0]), 10);

  applyRoll(g, 3); // red 7 -> 10
  const report = applyMove(g, 0);
  assert.equal(report.captures.length, 1);
  assert.equal(report.captures[0].color, 'blue');
  assert.equal(g.players[1].tokens[0], -1);
  assert.equal(report.extraTurn, true, 'quem captura joga de novo');
  assert.equal(currentPlayer(g).color, 'red');
});

test('não há captura em casa segura', () => {
  const g = twoPlayer();
  // casa física 8 é segura
  g.players[1].tokens = [(8 - 39 + 52) % 52, -1, -1, -1];
  g.players[0].tokens = [5, -1, -1, -1];
  applyRoll(g, 3); // red 5 -> 8
  const report = applyMove(g, 0);
  assert.equal(report.captures.length, 0);
  assert.notEqual(g.players[1].tokens[0], -1);
});

test('duas peças adversárias bloqueiam a casa', () => {
  const g = twoPlayer();
  const bluePos = (10 - 39 + 52) % 52;
  g.players[1].tokens = [bluePos, bluePos, -1, -1];
  g.players[0].tokens = [7, -1, -1, -1];
  assert.equal(isBlockedForLanding(g, g.players[0], 10), true);
  assert.deepEqual(legalMoves(g, g.players[0], 3), [], 'não pode pousar sobre o bloqueio');
});

test('o corredor final nunca é bloqueado', () => {
  const g = twoPlayer();
  g.players[0].tokens = [52, 52, -1, -1];
  assert.equal(isBlockedForLanding(g, g.players[0], 52), false);
});

test('aliados não se capturam nem se bloqueiam', () => {
  const g = createGame({
    colors: ['red', 'green', 'yellow', 'blue'],
    teams: { red: 'A', yellow: 'A', green: 'B', blue: 'B' },
  });
  const yellowPos = (10 - 26 + 52) % 52;
  g.players[2].tokens = [yellowPos, yellowPos, -1, -1]; // yellow, aliado de red
  g.players[0].tokens = [7, -1, -1, -1];
  assert.equal(isBlockedForLanding(g, g.players[0], 10), false, 'aliado não bloqueia');

  applyRoll(g, 3);
  const report = applyMove(g, 0);
  assert.equal(report.captures.length, 0, 'aliado não é capturado');
});

test('levar as quatro peças à chegada encerra a partida', () => {
  const g = twoPlayer();
  g.players[0].tokens = [HOME_POS, HOME_POS, HOME_POS, 55];
  applyRoll(g, 1);
  const report = applyMove(g, 3);
  assert.equal(report.finished, true);
  assert.equal(report.gameOver, true);
  assert.equal(g.gameOver, true);
  assert.equal(g.winnerColor, 'red');
});

test('jogada ilegal é rejeitada', () => {
  const g = twoPlayer();
  applyRoll(g, 3);
  assert.throws(() => applyMove(g, 0), RuleError);
});

test('mover sem lançar o dado é rejeitado', () => {
  const g = twoPlayer();
  assert.throws(() => applyMove(g, 0), RuleError);
});

test('lançar o dado duas vezes no mesmo turno é rejeitado', () => {
  const g = twoPlayer();
  applyRoll(g, 6);
  assert.throws(() => applyRoll(g, 6), RuleError);
});

test('valor de dado fora de 1..6 é rejeitado', () => {
  const g = twoPlayer();
  assert.throws(() => applyRoll(g, 0), RuleError);
  assert.throws(() => applyRoll(g, 7), RuleError);
  assert.throws(() => applyRoll(g, 3.5), RuleError);
});

test('o replay reconstrói exatamente o mesmo estado final', () => {
  const setup = { colors: ['red', 'blue'] };
  const g = createGame(setup);
  const events = [];
  const push = (ev) => { events.push(ev); return ev; };

  applyRoll(g, 6); push({ type: 'roll', die: 6 });
  applyMove(g, 0); push({ type: 'move', tokenIndex: 0 });
  applyRoll(g, 4); push({ type: 'roll', die: 4 });
  applyMove(g, 0); push({ type: 'move', tokenIndex: 0 });
  applyRoll(g, 2); push({ type: 'roll', die: 2 });
  applyNoMove(g); push({ type: 'no_move' });

  const replayed = replay(setup, events);
  assert.deepEqual(replayed.players, g.players);
  assert.equal(replayed.turnIndex, g.turnIndex);
  assert.equal(replayed.gameOver, g.gameOver);
});

test('um log adulterado não reproduz o estado alegado', () => {
  const setup = { colors: ['red', 'blue'] };
  const events = [
    { type: 'roll', die: 6 },
    { type: 'move', tokenIndex: 0 },
  ];
  const honest = replay(setup, events);
  const tampered = [...events, { type: 'move', tokenIndex: 1 }];
  assert.throws(() => replay(setup, tampered), RuleError, 'mover sem lançar o dado não passa');
  assert.equal(honest.players[0].tokens[0], 0);
});
