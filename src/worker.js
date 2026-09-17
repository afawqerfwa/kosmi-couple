const FALLBACK_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "kosmi-couple-cloudflare" });
    }

    if (url.pathname === "/config") {
      return Response.json({ iceServers: getIceServers(env) });
    }

    if (url.pathname === "/socket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const roomId = cleanRoomId(url.searchParams.get("room"));
      if (roomId.length < 4) return new Response("A valid room is required", { status: 400 });
      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const roomId = cleanRoomId(new URL(request.url).searchParams.get("room"));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = crypto.randomUUID();

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id: connectionId, roomId });
    emit(server, "server:ready", { iceServers: getIceServers(this.env) });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(webSocket, message) {
    let payload;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      payload = JSON.parse(text);
    } catch (_error) {
      return;
    }
    if (!payload?.event) return;

    const data = payload.data || {};
    if (payload.event === "room:join") return this.join(webSocket, data);

    const attachment = webSocket.deserializeAttachment();
    if (!attachment?.roomId) return emit(webSocket, "room:error", "اول وارد اتاق بشید.");

    if (payload.event === "movie:set") return this.setMovie(webSocket, data);
    if (payload.event === "movie:clear") return this.clearMovie(webSocket);
    if (payload.event === "video:sync") return this.syncVideo(webSocket, data);
    if (payload.event === "chat:send") return this.sendChat(webSocket, data);
    if (payload.event === "webrtc:offer") return this.relay(webSocket, "webrtc:offer", data);
    if (payload.event === "webrtc:answer") return this.relay(webSocket, "webrtc:answer", data);
    if (payload.event === "webrtc:ice") return this.relay(webSocket, "webrtc:ice", data);
  }

  async join(webSocket, data) {
    const attachment = webSocket.deserializeAttachment() || {};
    const roomId = cleanRoomId(data.roomId || attachment.roomId);
    if (roomId.length < 4 || roomId !== attachment.roomId) {
      return emit(webSocket, "room:error", "کد اتاق درست نیست.");
    }

    const room = await this.getRoom();
    const existing = room.users.find((user) => user.id === attachment.id);
    if (room.users.length >= 2 && !existing) {
      return emit(webSocket, "room:error", "این اتاق پره؛ فقط دو نفر می‌تونن وارد بشن 💜");
    }

    const user = {
      id: attachment.id,
      name: cleanName(data.name),
      online: true,
    };
    room.users = room.users.filter((item) => item.id !== user.id);
    room.users.push(user);
    webSocket.serializeAttachment({ ...attachment, roomId, name: user.name });
    await this.saveRoom(room);

    emit(webSocket, "room:joined", { roomId, selfId: user.id });
    emit(webSocket, "room:state", room);
    if (!existing) this.broadcast(roomId, "room:user-joined", user, webSocket);
    this.broadcastUsers(roomId, room.users);
  }

  async setMovie(webSocket, movie) {
    const attachment = webSocket.deserializeAttachment();
    const safeMovie = validMovie(movie);
    if (!attachment?.roomId || !safeMovie) return;
    const room = await this.getRoom();
    room.movie = safeMovie;
    room.playback = { ...room.playback, time: 0, paused: true, updatedAt: Date.now() };
    await this.saveRoom(room);
    this.broadcast(attachment.roomId, "movie:set", safeMovie, webSocket);
    emit(webSocket, "movie:accepted", safeMovie);
    this.broadcast(attachment.roomId, "video:sync", room.playback);
  }

  async clearMovie(webSocket) {
    const attachment = webSocket.deserializeAttachment();
    if (!attachment?.roomId) return;
    const room = await this.getRoom();
    room.movie = null;
    room.playback = { ...room.playback, time: 0, paused: true, updatedAt: Date.now() };
    await this.saveRoom(room);
    this.broadcast(attachment.roomId, "movie:cleared");
    this.broadcast(attachment.roomId, "video:sync", room.playback);
  }

  async syncVideo(webSocket, payload) {
    const attachment = webSocket.deserializeAttachment();
    if (!attachment?.roomId) return;
    const room = await this.getRoom();
    const time = Number(payload.time);
    const rate = Number(payload.rate);
    const volume = Number(payload.volume);
    room.playback = {
      time: Number.isFinite(time) ? Math.max(0, time) : room.playback.time,
      paused: Boolean(payload.paused),
      rate: Number.isFinite(rate) ? Math.min(4, Math.max(.25, rate)) : room.playback.rate,
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : room.playback.volume,
      muted: Boolean(payload.muted),
      updatedAt: Date.now(),
    };
    await this.saveRoom(room);
    this.broadcast(attachment.roomId, "video:sync", room.playback, webSocket);
  }

  async sendChat(webSocket, text) {
    const attachment = webSocket.deserializeAttachment();
    const message = String(text || "").trim().slice(0, 500);
    if (!attachment?.roomId || !message) return;
    const room = await this.getRoom();
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: attachment.id,
      sender: attachment.name || "مهمان",
      text: message,
      at: Date.now(),
    };
    room.chat.push(item);
    room.chat = room.chat.slice(-80);
    await this.saveRoom(room);
    this.broadcast(attachment.roomId, "chat:message", item);
  }

  async relay(webSocket, event, data) {
    const attachment = webSocket.deserializeAttachment();
    if (!attachment?.roomId || !data.target) return;
    const target = this.findSocket(data.target, attachment.roomId);
    if (!target) return;
    const forwarded = { from: attachment.id };
    if (event === "webrtc:ice") forwarded.candidate = data.candidate;
    else forwarded.sdp = data.sdp;
    emit(target, event, forwarded);
  }

  async getRoom() {
    return (await this.state.storage.get("room")) || createRoom();
  }

  async saveRoom(room) {
    await this.state.storage.put("room", room);
  }

  findSocket(id, roomId) {
    return this.state.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment();
      return attachment?.id === id && attachment.roomId === roomId;
    });
  }

  broadcast(roomId, event, data, except) {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.roomId === roomId && socket !== except) emit(socket, event, data);
    }
  }

  broadcastUsers(roomId, users) {
    this.broadcast(roomId, "room:users", users);
  }

  async leave(webSocket) {
    const attachment = webSocket.deserializeAttachment();
    if (!attachment?.roomId) return;
    const room = await this.getRoom();
    const wasMember = room.users.some((user) => user.id === attachment.id);
    if (!wasMember) return;
    room.users = room.users.filter((user) => user.id !== attachment.id);
    if (!room.users.length) await this.state.storage.delete("room");
    else await this.saveRoom(room);
    this.broadcast(attachment.roomId, "room:user-left", { id: attachment.id });
    if (room.users.length) this.broadcastUsers(attachment.roomId, room.users);
  }

  async webSocketClose(webSocket) {
    await this.leave(webSocket);
  }

  async webSocketError(webSocket) {
    await this.leave(webSocket);
  }
}

function emit(webSocket, event, data) {
  try {
    webSocket.send(JSON.stringify({ event, data }));
  } catch (_error) {}
}

function createRoom() {
  return {
    users: [],
    movie: null,
    playback: { time: 0, paused: true, rate: 1, volume: 1, muted: false, updatedAt: Date.now() },
    chat: [],
  };
}

function cleanRoomId(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

function cleanName(value) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, 28) || "مهمان";
}

function validMovie(movie) {
  if (!movie || !["url", "file"].includes(movie.type)) return null;
  const safe = {
    type: movie.type,
    title: String(movie.title || "فیلم مشترک").slice(0, 140),
    fileId: String(movie.fileId || "").slice(0, 80),
    size: Number(movie.size) || 0,
    mime: String(movie.mime || "video/mp4").slice(0, 80),
  };
  if (movie.type === "url") {
    try {
      const url = new URL(String(movie.url || ""));
      if (!/^https?:$/.test(url.protocol)) return null;
      safe.url = url.href;
    } catch (_error) {
      return null;
    }
  }
  return safe;
}

function getIceServers(env) {
  if (env.TURN_ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(env.TURN_ICE_SERVERS_JSON);
      if (Array.isArray(parsed) && parsed.length) return [...FALLBACK_ICE_SERVERS, ...parsed];
    } catch (_error) {}
  }
  const urls = String(env.TURN_URLS || "").split(",").map((url) => url.trim()).filter(Boolean);
  if (urls.length && env.TURN_USERNAME && env.TURN_PASSWORD) {
    return [...FALLBACK_ICE_SERVERS, { urls, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD }];
  }
  return FALLBACK_ICE_SERVERS;
}
