// game.js
// ---------------------------------------------------------------
// Вся игровая логика "Дуэли часов" отдельно от WebSocket-транспорта.
// Так её можно проверить тестами без реальной сети, а server.js
// просто подключает эти функции к реальным сокетам.
// ---------------------------------------------------------------

const TURN_SECONDS = 20;

function randomHour() {
  return Math.floor(Math.random() * 12) + 1;
}

function otherColor(color) {
  return color === 'red' ? 'blue' : 'red';
}

function createRoomState(code) {
  return {
    code,
    hands: { red: 12, blue: 12 },
    round: 1,
    startingPlayer: Math.random() < 0.5 ? 'red' : 'blue',
    secretHour: null,
    currentPlayer: null,
    guesses: { red: null, blue: null },
    turnTimeout: null,
    restartVotes: new Set()
  };
}

// io = { send(color, payload), broadcast(payload), scheduleTimeout(fn, ms) -> handle, clearTimeout(handle) }
function startRound(room, io) {
  room.secretHour = randomHour();
  room.guesses = { red: null, blue: null };
  room.currentPlayer = room.startingPlayer;
  startTurn(room, io);
}

function startTurn(room, io) {
  io.clearTimeout(room.turnTimeout);
  const deadline = Date.now() + TURN_SECONDS * 1000;

  ['red', 'blue'].forEach((color) => {
    io.send(color, {
      type: 'turn_start',
      round: room.round,
      currentPlayer: room.currentPlayer,
      isYourTurn: color === room.currentPlayer,
      yourHand: room.hands[color],
      deadline
    });
  });

  room.turnTimeout = io.scheduleTimeout(() => {
    handleConfirm(room, io, room.currentPlayer, room.hands[room.currentPlayer]);
  }, TURN_SECONDS * 1000 + 300);
}

function handleConfirm(room, io, color, hour) {
  if (color !== room.currentPlayer) return false;
  io.clearTimeout(room.turnTimeout);

  const clamped = Number.isInteger(hour) && hour >= 1 && hour <= 12 ? hour : room.hands[color];
  room.hands[color] = clamped;
  room.guesses[color] = clamped;

  if (room.guesses.red === null || room.guesses.blue === null) {
    room.currentPlayer = otherColor(color);
    startTurn(room, io);
  } else {
    evaluateRound(room, io);
  }
  return true;
}

function evaluateRound(room, io) {
  const redCorrect = room.guesses.red === room.secretHour;
  const blueCorrect = room.guesses.blue === room.secretHour;

  let outcome;
  if (!redCorrect && !blueCorrect) outcome = 'continue';
  else if (redCorrect && blueCorrect) outcome = 'draw';
  else outcome = redCorrect ? 'red' : 'blue';

  io.broadcast({
    type: 'round_result',
    round: room.round,
    secretHour: room.secretHour,
    guesses: { ...room.guesses },
    outcome
  });

  if (outcome === 'continue') {
    room.round += 1;
    room.startingPlayer = otherColor(room.startingPlayer);
    io.scheduleTimeout(() => startRound(room, io), 2500);
  }
  return outcome;
}

function resetMatch(room, io) {
  room.hands = { red: 12, blue: 12 };
  room.round = 1;
  room.startingPlayer = Math.random() < 0.5 ? 'red' : 'blue';
  startRound(room, io);
}

module.exports = { createRoomState, startRound, startTurn, handleConfirm, evaluateRound, resetMatch, otherColor, randomHour };
