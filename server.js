// server.js
// ---------------------------------------------------------------
// Backend-сервер игры "Дуэль часов".
// Сам он только принимает подключения и передаёт сообщения —
// все правила игры живут в game.js (Server-authoritative logic).
// ---------------------------------------------------------------

const http = require('http');
const { WebSocketServer } = require('ws');
const {
  createRoomState,
  startRound,
  handleConfirm,
  resetMatch,
  otherColor
} = require('./game');

const PORT = process.env.PORT || 3000;
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
      const color = Math.random() < 0.5 ? 'red' : 'blue';
      room.sockets[color] = ws;
      rooms.set(code, room);

      ws.roomCode = code;
      ws.color = color;
      send(ws, { type: 'created', code, color });
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
      room.sockets[myColor] = ws;
      ws.roomCode = room.code;
      ws.color = myColor;

      send(ws, { type: 'joined', code: room.code, color: myColor });
      send(room.sockets[takenColor], { type: 'opponent_joined' });

      startRound(room, makeIo(room));
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
    if (!room) return;
    send(room.sockets[otherColor(ws.color)], { type: 'opponent_disconnected' });
    clearTimeout(room.turnTimeout);
    rooms.delete(room.code);
  });
});

httpServer.listen(PORT, () => {
  console.log('Clock duel server listening on port ' + PORT);
});
