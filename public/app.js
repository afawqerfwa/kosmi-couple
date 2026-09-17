function createSocket() {
  const listeners = new Map();
  let connection = null;
  let queued = [];

  const dispatch = (event, data) => {
    (listeners.get(event) || []).forEach((handler) => handler(data));
  };

  const api = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return api;
    },
    emit(event, data) {
      const message = JSON.stringify({ event, data });
      if (connection?.readyState === WebSocket.OPEN) connection.send(message);
      else queued.push(message);
    },
    connect(roomId) {
      if (connection) connection.close();
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const endpoint = `${protocol}//${location.host}/socket?room=${encodeURIComponent(roomId)}`;
      connection = new WebSocket(endpoint);
      connection.onopen = () => {
        dispatch("connect");
        queued.splice(0).forEach((message) => connection.send(message));
      };
      connection.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data);
          if (message.event) dispatch(message.event, message.data);
        } catch (_error) {}
      };
      connection.onerror = () => dispatch("connect_error");
      connection.onclose = () => dispatch("disconnect");
    },
    disconnect() {
      queued = [];
      if (connection) connection.close();
      connection = null;
    },
  };
  return api;
}

const socket = createSocket();
const $ = (selector) => document.querySelector(selector);

const lobby = $("#lobby");
const roomView = $("#room");
const joinForm = $("#join-form");
const nameInput = $("#name-input");
const roomInput = $("#room-input");
const lobbyError = $("#lobby-error");
const video = $("#movie-player");
const videoEmpty = $("#video-empty");
const transferOverlay = $("#transfer-overlay");
const transferProgress = $("#transfer-progress");
const transferPercent = $("#transfer-percent");
const toast = $("#toast");

let roomId = "";
let selfId = "";
let selfName = "";
let users = [];
let currentMovie = null;
let localFile = null;
let localFileUrl = "";
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let peerConnection = null;
let peerTarget = "";
let localCaptureStream = null;
let remoteStream = null;
let streamingMovie = false;
let pendingCandidates = [];
let suppressUntil = 0;
let toastTimer;

try {
  nameInput.value = localStorage.getItem("kosmi-name") || "";
} catch (_error) {}

const initialRoom = new URLSearchParams(location.search).get("room");
if (initialRoom) roomInput.value = initialRoom.toUpperCase();

function setConnection(label, state = "online") {
  $("#connection-label").textContent = label;
  const dot = $("#connection-dot");
  dot.className = `status-dot ${state === "online" ? "online" : state === "warn" ? "warn" : ""}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function initials(name) {
  return String(name || "؟").trim().slice(0, 1).toUpperCase();
}

function otherUser() {
  return users.find((user) => user.id !== selfId);
}

function renderPeople() {
  const row = $("#people-row");
  const list = $("#people-list");
  row.replaceChildren();
  list.replaceChildren();
  if (!users.length) {
    list.innerHTML = '<p class="chat-empty">هنوز کسی توی اتاق نیست.</p>';
    return;
  }
  users.forEach((user) => {
    const mini = document.createElement("span");
    mini.className = "mini-avatar";
    mini.textContent = initials(user.name);
    mini.title = user.id === selfId ? `${user.name} (شما)` : user.name;
    row.append(mini);

    const item = document.createElement("div");
    item.className = "person";
    item.innerHTML = `<span class="avatar">${initials(user.name)}</span><span class="person-info"><strong></strong><small></small></span><span class="person-status"></span>`;
    item.querySelector("strong").textContent = user.id === selfId ? `${user.name} (شما)` : user.name;
    item.querySelector("small").textContent = user.id === selfId ? "خودتون" : "عشقولی شما";
    list.append(item);
  });
  $("#people-subtitle").textContent = users.length === 2 ? "هر دوتون آماده‌اید 🍿" : "لینک اتاق رو برای عشقولیتون بفرستید";
  if (users.length === 2 && !peerConnection && currentMovie?.type === "file" && localFile) {
    createSenderPeer(otherUser().id);
  }
}

function setRoomVisible(visible) {
  lobby.classList.toggle("hidden", visible);
  roomView.classList.toggle("hidden", !visible);
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const part = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "فیلم آنلاین");
    return part.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]{2,5}$/i, "") || "فیلم آنلاین";
  } catch (_error) {
    return "فیلم آنلاین";
  }
}

function displayMovie(movie, waiting = false) {
  currentMovie = movie;
  $("#movie-title").textContent = movie ? movie.title : "انتخاب فیلم برای تماشای مشترک 🎬";
  $("#movie-subtitle").textContent = movie
    ? movie.type === "file" ? `${formatBytes(movie.size)} • مستقیم برای عشقولیتون می‌ره` : "لینک فیلم برای هر دوتون آماده‌ست"
    : "یه فیلم اضافه کنید تا با هم شروع کنیم.";
  $("#clear-movie").classList.toggle("hidden", !movie);
  if (!movie) {
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
    videoEmpty.classList.remove("hidden");
    transferOverlay.classList.add("hidden");
    return;
  }
  if (movie.type === "url") {
    video.srcObject = null;
    transferOverlay.classList.add("hidden");
    if (video.dataset.source !== movie.url) {
      video.dataset.source = movie.url;
      video.src = movie.url;
      video.load();
    }
    video.hidden = false;
    videoEmpty.classList.add("hidden");
    return;
  }
  const availableLocal = localFile && localFileId() === movie.fileId;
  if (availableLocal) setVideoUrl(localFileUrl);
  else {
    video.srcObject = null;
    video.hidden = true;
    videoEmpty.classList.add("hidden");
    if (waiting) showStreamWaiting(`منتظر پخش ${movie.title} از عشقولی هستیم`);
  }
}

function setVideoUrl(url) {
  if (video.dataset.source !== url) {
    video.srcObject = null;
    video.dataset.source = url;
    video.src = url;
    video.load();
  }
  video.hidden = false;
  videoEmpty.classList.add("hidden");
  transferOverlay.classList.add("hidden");
  transferOverlay.classList.remove("waiting");
}

function formatBytes(bytes) {
  if (!bytes) return "فایل ویدئویی";
  const units = ["بایت", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderChat(messages) {
  const container = $("#chat-messages");
  container.replaceChildren();
  if (!messages.length) {
    container.innerHTML = '<p class="chat-empty">اولین پیام رو شما بفرستید 💜</p>';
    return;
  }
  messages.forEach(addChatMessage);
  container.scrollTop = container.scrollHeight;
}

function addChatMessage(message) {
  const container = $("#chat-messages");
  container.querySelector(".chat-empty")?.remove();
  const mine = message.senderId === selfId;
  const item = document.createElement("div");
  item.className = `message ${mine ? "mine" : ""}`;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `${mine ? "شما" : message.sender} • ${new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.at))}`;
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message.text;
  item.append(meta, bubble);
  container.append(item);
  container.scrollTop = container.scrollHeight;
}

function localFileId() {
  return localFile ? `${localFile.name}:${localFile.size}:${localFile.lastModified}` : "";
}

function closePeer() {
  streamingMovie = false;
  pendingCandidates = [];
  if (localCaptureStream) localCaptureStream.getTracks().forEach((track) => track.stop());
  if (remoteStream) remoteStream.getTracks().forEach((track) => track.stop());
  if (peerConnection) peerConnection.close();
  localCaptureStream = null;
  remoteStream = null;
  peerConnection = null;
  peerTarget = "";
  updatePeerConnectionStatus("منتظر اتصال عشقولی", "warn");
}

function updatePeerConnectionStatus(label, state = "warn") {
  if (roomView.classList.contains("hidden")) return;
  setConnection(label, state);
}

function configurePeer(pc, targetId) {
  peerConnection = pc;
  peerTarget = targetId;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("webrtc:ice", { target: peerTarget, candidate });
  };
  pc.ontrack = ({ streams }) => {
    const stream = streams?.[0];
    if (!stream) return;
    remoteStream = stream;
    video.removeAttribute("src");
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.hidden = false;
    videoEmpty.classList.add("hidden");
    transferOverlay.classList.add("hidden");
    transferOverlay.classList.remove("waiting");
    video.play().catch(() => showToast("برای شروع پخش، روی دکمه پخش بزنید."));
    showToast("پخش مستقیم وصل شد؛ بزن بریم 🍿");
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") updatePeerConnectionStatus("دو نفرتون متصل و همگامید 💜", "online");
    else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) updatePeerConnectionStatus("اتصال یه کم ناپایداره", "warn");
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") showToast("اتصال مستقیم جور نشد؛ تنظیم TURN رو بررسی کنید.");
  };
}

function makePeerConnection(targetId) {
  closePeer();
  const pc = new RTCPeerConnection({ iceServers });
  configurePeer(pc, targetId);
  return pc;
}

async function createSenderPeer(targetId) {
  if (!localFile || !targetId || streamingMovie) return;
  const pc = makePeerConnection(targetId);
  try {
    await video.play().catch(() => {});
    const capture = video.captureStream?.() || video.mozCaptureStream?.();
    if (!capture) throw new Error("captureStream is not supported");
    localCaptureStream = capture;
    streamingMovie = true;
    capture.getTracks().forEach((track) => pc.addTrack(track, capture));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc:offer", { target: targetId, sdp: pc.localDescription });
    updatePeerConnectionStatus("دارم پخش مستقیم رو وصل می‌کنم...", "warn");
  } catch (_error) {
    streamingMovie = false;
    showToast("مرورگر شما پخش مستقیم فایل رو پشتیبانی نمی‌کنه؛ از لینک مستقیم استفاده کنید.");
  }
}

function showStreamWaiting(title) {
  transferOverlay.classList.remove("hidden");
  transferOverlay.classList.add("waiting");
  $("#transfer-title").textContent = title;
  transferProgress.style.width = "0";
  transferPercent.textContent = "پخش زنده";
}

async function applyRemotePlayback(state) {
  if (!state || (!video.src && !currentMovie)) return;
  const delay = state.paused ? 0 : Math.max(0, (Date.now() - state.updatedAt) / 1000);
  const targetTime = state.time + delay;
  suppressUntil = Date.now() + 650;
  const align = () => {
    try {
      if (Math.abs(video.currentTime - targetTime) > 0.35) video.currentTime = targetTime;
      video.playbackRate = state.rate;
      video.volume = state.volume;
      video.muted = state.muted;
      if (state.paused) video.pause();
      else video.play().catch(() => showToast("برای شروع، روی دکمه پخش بزنید."));
      updateCustomControls();
    } catch (_error) {}
  };
  if (video.readyState >= 1) align();
  else video.addEventListener("loadedmetadata", align, { once: true });
}

function emitPlayback(force = false) {
  if (!roomId || (!video.src && !video.srcObject) || (!force && Date.now() < suppressUntil)) return;
  socket.emit("video:sync", { time: video.currentTime, paused: video.paused, rate: video.playbackRate, volume: video.volume, muted: video.muted });
}

function formatClock(value) {
  if (!Number.isFinite(value) || value < 0) return "۰۰:۰۰";
  const minutes = Math.floor(value / 60).toString().padStart(2, "0");
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateCustomControls() {
  const playButton = $("#play-pause-button");
  const timeline = $("#timeline");
  const timeLabel = $("#time-label");
  if (!playButton || !timeline || !timeLabel) return;
  playButton.textContent = video.paused ? "▶ پخش" : "❚❚ توقف";
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  timeline.value = duration ? Math.round((video.currentTime / duration) * 1000) : 0;
  timeLabel.textContent = `${formatClock(video.currentTime)} / ${formatClock(duration)}`;
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  lobbyError.textContent = "";
  selfName = nameInput.value.trim().slice(0, 28);
  roomId = roomInput.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!selfName || roomId.length < 4) {
    lobbyError.textContent = "اسم و کد اتاق رو کامل وارد کنید.";
    return;
  }
  try { localStorage.setItem("kosmi-name", selfName); } catch (_error) {}
  socket.connect(roomId);
  socket.emit("room:join", { roomId, name: selfName });
  setConnection("دارم وصل می‌شم...", "warn");
});

$("#random-room").addEventListener("click", () => {
  roomInput.value = `LOVE-${Math.floor(100 + Math.random() * 900)}`;
});

$("#leave-room").addEventListener("click", () => {
  closePeer();
  socket.disconnect();
  location.href = location.pathname;
});

$("#copy-room").addEventListener("click", async () => {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
  try { await navigator.clipboard.writeText(link); showToast("لینک اتاق کپی شد؛ بفرستید برای عشقولیتون 💌"); }
  catch (_error) { showToast(`کد اتاق: ${roomId}`); }
});

$("#empty-add").addEventListener("click", () => $("#movie-file").click());

$("#add-url").addEventListener("click", () => {
  const url = $("#movie-url").value.trim();
  if (!/^https?:\/\//i.test(url)) return showToast("یه لینک معتبر https یا http وارد کنید.");
  closePeer();
  localFile = null;
  if (localFileUrl) URL.revokeObjectURL(localFileUrl);
  localFileUrl = "";
  const movie = { type: "url", url, title: titleFromUrl(url) };
  displayMovie(movie);
  socket.emit("movie:set", movie);
  showToast("فیلم برای هر دوتون آماده شد 🍿");
});

$("#movie-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("video/")) return showToast("لطفاً یه فایل ویدئویی انتخاب کنید.");
  localFile = file;
  if (localFileUrl) URL.revokeObjectURL(localFileUrl);
  localFileUrl = URL.createObjectURL(file);
  const movie = { type: "file", title: file.name, size: file.size, mime: file.type, fileId: localFileId() };
  displayMovie(movie);
  setVideoUrl(localFileUrl);
  socket.emit("movie:set", movie);
  if (otherUser()) {
    closePeer();
    const startStreaming = () => createSenderPeer(otherUser().id);
    if (video.readyState >= 1) startStreaming();
    else video.addEventListener("loadedmetadata", startStreaming, { once: true });
  }
  showToast("فیلم انتخاب شد؛ دارم پخش مستقیم رو آماده می‌کنم 💌");
  event.target.value = "";
});

  $("#clear-movie").addEventListener("click", () => {
  localFile = null;
  if (localFileUrl) URL.revokeObjectURL(localFileUrl);
  localFileUrl = "";
  closePeer();
  displayMovie(null);
  socket.emit("movie:clear");
});

$("#speed-select").addEventListener("change", (event) => {
  video.playbackRate = Number(event.target.value);
  emitPlayback(true);
});

$("#fullscreen-button").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#video-frame").requestFullscreen?.();
});

$("#play-pause-button").addEventListener("click", () => {
  if (!video.src && !video.srcObject) return showToast("اول یه فیلم اضافه کنید 🍿");
  if (video.paused) {
    video.play().then(() => emitPlayback(true)).catch(() => showToast("پخش خودکار اجازه نداد؛ دوباره روی پخش بزنید."));
  } else {
    video.pause();
    emitPlayback(true);
  }
});
$("#backward-button").addEventListener("click", () => {
  if (!video.src && !video.srcObject) return;
  video.currentTime = Math.max(0, video.currentTime - 10);
  updateCustomControls();
  emitPlayback(true);
});
$("#forward-button").addEventListener("click", () => {
  if (!video.src && !video.srcObject) return;
  const end = Number.isFinite(video.duration) ? video.duration : video.currentTime + 10;
  video.currentTime = Math.min(end, video.currentTime + 10);
  updateCustomControls();
  emitPlayback(true);
});
$("#timeline").addEventListener("input", (event) => {
  if (!Number.isFinite(video.duration)) return;
  video.currentTime = (Number(event.target.value) / 1000) * video.duration;
  updateCustomControls();
  emitPlayback(true);
});

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (message) { socket.emit("chat:send", message); input.value = ""; }
});

["play", "pause", "seeked", "ratechange", "volumechange", "ended"].forEach((eventName) => video.addEventListener(eventName, () => { updateCustomControls(); emitPlayback(); }));
video.addEventListener("timeupdate", updateCustomControls);
video.addEventListener("loadedmetadata", updateCustomControls);
updateCustomControls();

socket.on("server:ready", ({ iceServers: servers } = {}) => {
  if (Array.isArray(servers) && servers.length) iceServers = servers;
});
socket.on("connect", () => setConnection(roomId ? "اتصال عشقولی برقراره ✅" : "آماده‌ایم", "online"));
socket.on("disconnect", () => setConnection("اتصال قطع شد", "warn"));
socket.on("connect_error", () => setConnection("دارم دوباره وصل می‌شم...", "warn"));

socket.on("room:error", (message) => {
  lobbyError.textContent = message;
  setRoomVisible(false);
});
socket.on("room:joined", ({ roomId: id, selfId: idOfSelf }) => {
  roomId = id;
  selfId = idOfSelf;
  $("#room-code-label").textContent = roomId;
  setRoomVisible(true);
  history.replaceState({}, "", `${location.pathname}?room=${encodeURIComponent(roomId)}`);
  setConnection("اتصال عشقولی برقراره ✅", "online");
});
socket.on("room:state", (state) => {
  users = state.users || [];
  renderPeople();
  renderChat(state.chat || []);
  if (state.movie) {
    displayMovie(state.movie, state.movie.type === "file");
    if (state.movie.type === "file" && localFile && localFileId() === state.movie.fileId && otherUser()) createSenderPeer(otherUser().id);
  }
  if (state.playback) applyRemotePlayback(state.playback);
});
socket.on("room:users", (nextUsers) => { users = nextUsers || []; renderPeople(); });
socket.on("room:user-joined", ({ name }) => showToast(`${name} به اتاقتون پیوست 💜`));
socket.on("room:user-left", ({ id }) => {
  users = users.filter((user) => user.id !== id);
  renderPeople();
  if (peerTarget === id) closePeer();
  showToast("عشقولیتون از اتاق خارج شد.");
});
socket.on("movie:set", (movie) => {
  if (movie.type === "url") {
    closePeer();
    localFile = null;
    displayMovie(movie);
  } else {
    displayMovie(movie, true);
    showStreamWaiting(`منتظر پخش ${movie.title} از عشقولی هستیم`);
  }
});
socket.on("movie:cleared", () => {
  localFile = null;
  displayMovie(null);
});
socket.on("chat:message", addChatMessage);
socket.on("video:sync", applyRemotePlayback);

socket.on("webrtc:offer", async ({ from, sdp }) => {
  try {
    const pc = makePeerConnection(from);
    await pc.setRemoteDescription(sdp);
    for (const candidate of pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc:answer", { target: from, sdp: pc.localDescription });
  } catch (_error) {
    showToast("اتصال ارسال فیلم برقرار نشد.");
  }
});
socket.on("webrtc:answer", async ({ sdp }) => {
  try {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(sdp);
    for (const candidate of pendingCandidates.splice(0)) await peerConnection.addIceCandidate(candidate);
  } catch (_error) {}
});
socket.on("webrtc:ice", async ({ candidate }) => {
  if (!candidate) return;
  if (peerConnection?.remoteDescription) {
    try { await peerConnection.addIceCandidate(candidate); } catch (_error) {}
  } else pendingCandidates.push(candidate);
});

setInterval(() => {
  if (roomId && !video.paused) emitPlayback();
}, 4000);
