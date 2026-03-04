function registerWhenReady(cb) {
  if (typeof globalThis.runOnStartup === "function") {
    globalThis.runOnStartup(cb);
    return;
  }

  const maxWaitMs = 10000;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (typeof globalThis.runOnStartup === "function") {
      clearInterval(timer);
      globalThis.runOnStartup(cb);
      return;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      clearInterval(timer);
      console.error("[netcode] Construct runtime did not expose runOnStartup in time.");
    }
  }, 50);
}

const SEND_INTERVAL_MS = 50;
const SNAPSHOT_LERP_ALPHA = 0.25;
const REMOTE_TIMEOUT_MS = 10000;

function randomId(prefix = "p") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function pickRoomFromUI(runtime) {
  const codeObj = runtime.objects.codigo;
  if (!codeObj) return "sala-1";
  const input = codeObj.getFirstInstance();
  if (!input) return "sala-1";
  const value = (input.text || "").trim();
  return value || "sala-1";
}

function setRoomInUI(runtime, value) {
  const codeObj = runtime.objects.codigo;
  if (!codeObj) return;
  const input = codeObj.getFirstInstance();
  if (!input) return;
  input.text = value;
}

function pickNicknameFromUI(runtime) {
  const nickObj = runtime.objects.nome;
  if (!nickObj) return "Player";
  const input = nickObj.getFirstInstance();
  if (!input) return "Player";
  const value = (input.text || "").trim();
  return value || "Player";
}

function setStatus(runtime, text) {
  const txtObj = runtime.objects.TxtStatus;
  if (!txtObj) return;
  const txt = txtObj.getFirstInstance();
  if (!txt) return;
  txt.text = text;
}

function normalizeLabel(v) {
  return (v || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

registerWhenReady(async (runtime) => {
  let ws = null;
  let joined = false;
  let myId = "";
  let roomId = "";
  let nickname = "";
  let lastSend = 0;
  let didAttachMenuClickHandler = false;

  const remotes = new Map();

  function getWsUrl() {
    if (typeof window.C3_WS_URL === "string" && window.C3_WS_URL.trim()) {
      return window.C3_WS_URL.trim();
    }
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  }

  function getLocalPlayer() {
    const o = runtime.objects.PlayerLocal;
    return o ? o.getFirstInstance() : null;
  }

  function isOnMapLayout() {
    try {
      return runtime.layout && runtime.layout.name === "mapa1";
    } catch {
      return false;
    }
  }

  function goToMapLayout() {
    try {
      runtime.goToLayout("mapa1");
      return true;
    } catch (err) {
      console.error("[netcode] Failed to go to layout mapa1", err);
      return false;
    }
  }

  function createRemotePlayer(x, y) {
    const remoteType = runtime.objects.PlaterRemote;
    if (!remoteType) return null;

    const layer = runtime.layout.getLayer("Layer 0");
    if (!layer) return null;

    return remoteType.createInstance(layer, x, y);
  }

  function removeRemote(remoteId) {
    const data = remotes.get(remoteId);
    if (!data) return;
    if (data.inst && !data.inst.isDestroyed) {
      data.inst.destroy();
    }
    remotes.delete(remoteId);
  }

  function connectAndJoin() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const url = getWsUrl();
    roomId = pickRoomFromUI(runtime);
    nickname = pickNicknameFromUI(runtime);
    myId = randomId("player");

    setStatus(runtime, "Conectando...");
    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      joined = true;
      setStatus(runtime, `Online - Sala: ${roomId}`);
      ws.send(
        JSON.stringify({
          type: "join",
          roomId,
          playerId: myId,
          nickname,
        }),
      );
    });

    ws.addEventListener("message", (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (!msg || typeof msg !== "object") return;

      if (msg.type === "welcome" && typeof msg.playerId === "string") {
        myId = msg.playerId;
        return;
      }

      if (msg.type === "snapshot" && Array.isArray(msg.players)) {
        const now = performance.now();
        const seen = new Set();

        for (const p of msg.players) {
          if (!p || typeof p.playerId !== "string") continue;
          if (p.playerId === myId) continue;

          seen.add(p.playerId);
          let remote = remotes.get(p.playerId);

          if (!remote) {
            const inst = createRemotePlayer(Number(p.x) || 0, Number(p.y) || 0);
            if (!inst) continue;
            remote = {
              inst,
              targetX: Number(p.x) || 0,
              targetY: Number(p.y) || 0,
              lastStateTs: now,
            };
            remotes.set(p.playerId, remote);
          } else {
            remote.targetX = Number(p.x) || remote.targetX;
            remote.targetY = Number(p.y) || remote.targetY;
            remote.lastStateTs = now;
          }
        }

        for (const remoteId of remotes.keys()) {
          if (!seen.has(remoteId)) {
            removeRemote(remoteId);
          }
        }
      }

      if (msg.type === "despawn" && typeof msg.playerId === "string") {
        removeRemote(msg.playerId);
      }
    });

    ws.addEventListener("close", () => {
      joined = false;
      ws = null;
      setStatus(runtime, "Offline");
      for (const remoteId of remotes.keys()) removeRemote(remoteId);
    });

    ws.addEventListener("error", () => {
      setStatus(runtime, "Erro de conexao");
    });
  }

  function updateRemotes() {
    const now = performance.now();

    for (const [id, r] of remotes) {
      if (!r.inst || r.inst.isDestroyed) {
        remotes.delete(id);
        continue;
      }

      if (now - r.lastStateTs > REMOTE_TIMEOUT_MS) {
        removeRemote(id);
        continue;
      }

      r.inst.x = r.inst.x + (r.targetX - r.inst.x) * SNAPSHOT_LERP_ALPHA;
      r.inst.y = r.inst.y + (r.targetY - r.inst.y) * SNAPSHOT_LERP_ALPHA;
    }
  }

  function sendLocalState() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !joined) return;

    const player = getLocalPlayer();
    if (!player) return;

    ws.send(
      JSON.stringify({
        type: "state",
        roomId,
        playerId: myId,
        nickname,
        x: player.x,
        y: player.y,
      }),
    );
  }

  function handleMenuButtonClick(ev) {
    const target = ev.target;
    if (!target) return;

    const label = normalizeLabel(target.value || target.textContent || "");
    if (!label) return;

    if (label.includes("criar sala")) {
      const room = randomRoomCode();
      setRoomInUI(runtime, room);
      if (goToMapLayout()) {
        setTimeout(connectAndJoin, 150);
      }
      return;
    }

    if (label.includes("entrar")) {
      const current = pickRoomFromUI(runtime);
      if (!current || current === "sala-1") {
        setRoomInUI(runtime, "sala-1");
      }
      if (goToMapLayout()) {
        setTimeout(connectAndJoin, 150);
      }
    }
  }

  runtime.addEventListener("beforeprojectstart", () => {
    setStatus(runtime, "Offline");

    if (!didAttachMenuClickHandler) {
      didAttachMenuClickHandler = true;
      document.addEventListener("click", handleMenuButtonClick, true);
    }

    runtime.addEventListener("tick", () => {
      if (isOnMapLayout() && !ws) {
        connectAndJoin();
      }

      const now = performance.now();
      if (now - lastSend >= SEND_INTERVAL_MS) {
        lastSend = now;
        sendLocalState();
      }

      updateRemotes();
    });
  });
});
