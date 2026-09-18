// server.js
// ---------------------------------------------------------------
// Backend-сервер игры "Дуэль часов".
// Сам он только принимает подключения и передаёт сообщения —
// все правила игры живут в game.js (Server-authoritative logic).
// Этот файл также отвечает за reconnection (переподключение).
// ---------------------------------------------------------------

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const {
  createRoomState,
  startRound,
  startTurn,
  handleConfirm,
  resetMatch,
  otherColor
} = require('./game');

const PORT = process.env.PORT || 3000;
const RECONNECT_GRACE_MS = 45000; // 45 секунд на переподключение, прежде чем считать игрока выбывшим
const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// Адаптер: превращает абстрактные send/broadcast/таймеры из game.js
// в реальные вызовы WebSocket и setTimeout.
function makeIo(room) {
  return {
    send: (color, payload) => send(room.sockets[color], payload),
    broadcast: (payload) => {
      send(room.sockets.red, payload);
      send(room.sockets.blue, payload);
    },
    scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle)
  };
}

function deleteRoom(room) {
  clearTimeout(room.turnTimeout);
  clearTimeout(room.disconnectTimers.red);
  clearTimeout(room.disconnectTimers.blue);
  rooms.delete(room.code);
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Clock duel server is running.');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.color = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'create') {
      const code = makeRoomCode();
      const room = createRoomState(code);
      room.sockets = { red: null, blue: null };
      room.tokens = { red: null, blue: null };
      room.disconnectTimers = { red: null, blue: null };
      const color = Math.random() < 0.5 ? 'red' : 'blue';
      const token = crypto.randomUUID();
      room.sockets[color] = ws;
      room.tokens[color] = token;
      rooms.set(code, room);

      ws.roomCode = code;
      ws.color = color;
      send(ws, { type: 'created', code, color, token });
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get(String(msg.code || '').trim());
      if (!room) {
        send(ws, { type: 'error', message: 'Комната не найдена' });
        return;
      }
      if (room.sockets.red && room.sockets.blue) {
        send(ws, { type: 'error', message: 'Комната уже заполнена' });
        return;
      }
      const takenColor = room.sockets.red ? 'red' : 'blue';
      const myColor = otherColor(takenColor);
      const token = crypto.randomUUID();
      room.sockets[myColor] = ws;
      room.tokens[myColor] = token;
      ws.roomCode = room.code;
      ws.color = myColor;

      send(ws, { type: 'joined', code: room.code, color: myColor, token });
      send(room.sockets[takenColor], { type: 'opponent_joined' });

      startRound(room, makeIo(room));
      return;
    }

    if (msg.type === 'rejoin') {
      const room = rooms.get(String(msg.code || '').trim());
      if (!room) {
        send(ws, { type: 'room_gone' });
        return;
      }
      const color = room.tokens.red === msg.token ? 'red' : room.tokens.blue === msg.token ? 'blue' : null;
      if (!color) {
        send(ws, { type: 'room_gone' });
        return;
      }

      clearTimeout(room.disconnectTimers[color]);
      room.disconnectTimers[color] = null;
      room.sockets[color] = ws;
      ws.roomCode = room.code;
      ws.color = color;

      send(ws, { type: 'rejoined', code: room.code, color });
      send(room.sockets[otherColor(color)], { type: 'opponent_reconnected' });

      if (room.secretHour === null) {
        // Матч ещё не начался (второй игрок ещё не подключался) —
        // просто возвращаем в экран ожидания, а не в игру.
        return;
      }

      const io = makeIo(room);
      // Перезапускаем именно текущий ход (не весь раунд), чтобы не
      // потерять уже сделанный ход второго игрока в этом раунде.
      startTurn(room, io);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (msg.type === 'confirm') {
      handleConfirm(room, makeIo(room), ws.color, msg.hour);
      return;
    }

    if (msg.type === 'restart') {
      room.restartVotes.add(ws.color);
      if (room.restartVotes.size === 2) {
        room.restartVotes.clear();
        resetMatch(room, makeIo(room));
      }
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room || room.sockets[ws.color] !== ws) return; // это старый, уже заменённый сокет — игнорируем

    const color = ws.color;
    room.sockets[color] = null;
    clearTimeout(room.turnTimeout); // ставим игру на паузу, пока игрок не вернётся

    const opponentSocket = room.sockets[otherColor(color)];
    if (!opponentSocket) {
      // Оба отключились — комнату можно сразу убрать.
      deleteRoom(room);
      return;
    }

    send(opponentSocket, { type: 'opponent_disconnected', graceSeconds: RECONNECT_GRACE_MS / 1000 });

    room.disconnectTimers[color] = setTimeout(() => {
      send(room.sockets[otherColor(color)], { type: 'opponent_left' });
      deleteRoom(room);
    }, RECONNECT_GRACE_MS);
  });
});

httpServer.listen(PORT, () => {
  console.log('Clock duel server listening on port ' + PORT);
});
    
