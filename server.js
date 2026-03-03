const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

const rooms = new Map();

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function setCachingHeaders(res, filePath) {
  const file = filePath.replace(/\\/g, "/");
  const noCacheFiles = new Set(["/index.html", "/appmanifest.json"]);
  if (noCacheFiles.has(file)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
}

function safeResolvePath(urlPath) {
  const cleanPath = decodeURIComponent((urlPath || "/").split("?")[0]);
  const relativePath = cleanPath === "/" ? "/index.html" : cleanPath;
  const resolved = path.normalize(path.join(ROOT, relativePath));

  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

function parseJson(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function removeFromRoom(ws) {
  if (!ws._roomId || !ws._playerId) return;
  const room = rooms.get(ws._roomId);
  if (!room) return;

  room.delete(ws._playerId);
  broadcast(ws._roomId, { type: "despawn", playerId: ws._playerId }, ws);

  if (room.size === 0) rooms.delete(ws._roomId);
}

function broadcast(roomId, payload, exceptWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(payload);

  for (const p of room.values()) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    if (exceptWs && p.ws === exceptWs) continue;
    p.ws.send(msg);
  }
}

function buildSnapshot(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];

  const players = [];
  for (const p of room.values()) {
    players.push({
      playerId: p.playerId,
      nickname: p.nickname,
      x: p.x,
      y: p.y,
      updatedAt: p.updatedAt
    });
  }
  return players;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  const resolvedPath = safeResolvePath(req.url);
  if (!resolvedPath) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  fs.stat(resolvedPath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const relative = `/${path.relative(ROOT, resolvedPath).replace(/\\/g, "/")}`;
    res.setHeader("Content-Type", getContentType(resolvedPath));
    res.setHeader("X-Content-Type-Options", "nosniff");
    setCachingHeaders(res, relative);

    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }

    const stream = fs.createReadStream(resolvedPath);
    stream.on("error", () => {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    });
    stream.pipe(res);
  });
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

wss.on("connection", (ws) => {
  ws._roomId = "";
  ws._playerId = "";

  ws.on("message", (raw) => {
    const msg = parseJson(raw);
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "sala-1");
      const playerId = String(msg.playerId || `p_${Math.random().toString(36).slice(2, 10)}`);
      const nickname = String(msg.nickname || "Player");

      removeFromRoom(ws);

      ws._roomId = roomId;
      ws._playerId = playerId;

      const room = getRoom(roomId);
      room.set(playerId, {
        ws,
        roomId,
        playerId,
        nickname,
        x: 0,
        y: 0,
        updatedAt: Date.now()
      });

      ws.send(JSON.stringify({ type: "welcome", playerId }));
      return;
    }

    if (msg.type === "state") {
      if (!ws._roomId || !ws._playerId) return;
      const room = rooms.get(ws._roomId);
      if (!room) return;
      const player = room.get(ws._playerId);
      if (!player) return;

      const x = Number(msg.x);
      const y = Number(msg.y);

      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < -20000 || x > 20000 || y < -20000 || y > 20000) return;

      player.x = x;
      player.y = y;
      player.updatedAt = Date.now();
    }
  });

  ws.on("close", () => {
    removeFromRoom(ws);
  });

  ws.on("error", () => {
    removeFromRoom(ws);
  });
});

setInterval(() => {
  for (const roomId of rooms.keys()) {
    const snapshot = buildSnapshot(roomId);
    broadcast(roomId, { type: "snapshot", players: snapshot });
  }
}, 100);

server.listen(PORT, () => {
  console.log(`HTTP+WS server listening on port ${PORT}`);
});
