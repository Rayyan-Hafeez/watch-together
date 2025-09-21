// public/script.js
// Watch Together — WebRTC (data channel) + Socket.io signaling + YouTube sync
// TURN: Metered OpenRelay (free) + Auto Room ID generation

let socket, pc, dataChannel;
let isOfferer = false, roomId = null, username = null;

// ---------- TURN / ICE ----------
const rtcConfig = {
  iceServers: [
    {
      urls: [
        "stun:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp"
      ],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

// ---------- UI ----------
const connectBtn   = document.getElementById("connectBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const roomInput    = document.getElementById("roomId");     // <input id="roomId">
const nameInput    = document.getElementById("username");   // <input id="username">
const statusEl     = document.getElementById("status");     // <span id="status">
const dcStateEl    = document.getElementById("dcState");    // <span id="dcState">
const messagesEl   = document.getElementById("messages");   // chat list
const chatInput    = document.getElementById("chatInput");
const sendBtn      = document.getElementById("sendBtn");
const ytUrlInput   = document.getElementById("ytUrl");
const loadBtn      = document.getElementById("loadBtn");
const playBtn      = document.getElementById("playBtn");
const pauseBtn     = document.getElementById("pauseBtn");
const seekBtn      = document.getElementById("seekBtn");
const seekSec      = document.getElementById("seekSec");
const videoStateEl = document.getElementById("videoState");

// ---------- Helpers ----------
const setStatus = (t) => (statusEl && (statusEl.innerHTML = `<code>${t}</code>`));
const setDC     = (t) => (dcStateEl && (dcStateEl.textContent = `DataChannel: ${t}`));

function addMessage({ user = "System", text, ts = Date.now() }) {
  if (!messagesEl) return;
  const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<div class="meta">${time} • ${user}</div><div>${text}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function generateRoomId(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const p = u.pathname.split("/");
    if (p.includes("embed")) return p[p.indexOf("embed")+1];
    if (p.includes("shorts")) return p[p.indexOf("shorts")+1];
  } catch {}
  return /^[\w-]{11}$/.test(url) ? url : null;
}

// ---------- YouTube ----------
let player, playerReady = false, suppressEvents = false;

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    height: "390",
    width: "640",
    videoId: "",
    playerVars: {
      playsinline: 1,
      rel: 0,
      origin: window.location.origin,
      host: "https://www.youtube.com",
    },
    events: {
      onReady: () => { playerReady = true; updateVideoState(); },
      onStateChange: onPlayerStateChange,
      onError: (e) => addMessage({ text: `YouTube error: ${e.data}` })
    },
  });
};

function updateVideoState() {
  if (!videoStateEl) return;
  if (!playerReady) { videoStateEl.textContent = "Player: not ready"; return; }
  const s = player.getPlayerState?.();
  const name = { [-1]:"unstarted", 0:"ended", 1:"playing", 2:"paused", 3:"buffering", 5:"cued" }[s] || "?";
  const t = Number(player.getCurrentTime?.() || 0).toFixed(1);
  videoStateEl.textContent = `Player: ${name} @ ${t}s`;
}

function onPlayerStateChange(e) {
  if (!dataChannel || dataChannel.readyState !== "open" || suppressEvents) return;
  const t = player?.getCurrentTime?.() || 0;
  if (e.data === YT.PlayerState.PLAYING) sendDC({ type: "yt_play", time: t });
  if (e.data === YT.PlayerState.PAUSED)  sendDC({ type: "yt_pause", time: t });
  updateVideoState();
}

function safeSeek(t){ try{ player.seekTo(t, true); }catch{} }
function safePlay(){ try{ player.playVideo(); }catch{} }
function safePause(){ try{ player.pauseVideo(); }catch{} }
function loadVideoNow(id){ if(playerReady) { try{ player.loadVideoById(id); }catch{} } }

// ---------- WebRTC ----------
function createPeer() {
  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (e) => { if (e.candidate) socket.emit("ice_candidate", { roomId, candidate: e.candidate }); };
  pc.oniceconnectionstatechange = () => addMessage({ text: `ICE: ${pc.iceConnectionState}` });
  pc.onconnectionstatechange    = () => addMessage({ text: `Peer: ${pc.connectionState}` });

  if (isOfferer) {
    dataChannel = pc.createDataChannel("chat-sync");
    setupDC();
  } else {
    pc.ondatachannel = (e) => { dataChannel = e.channel; setupDC(); };
  }
  return pc;
}

function setupDC() {
  dataChannel.onopen  = () => { setDC("open");  addMessage({ text:"Data channel opened." }); };
  dataChannel.onclose = () => { setDC("closed"); addMessage({ text:"Data channel closed." }); };
  dataChannel.onmessage = (e) => handleMsg(JSON.parse(e.data));
}

function sendDC(obj){ if(dataChannel?.readyState==="open") dataChannel.send(JSON.stringify({ ...obj, _ts: Date.now() })); }

async function makeOffer(){ const o=await pc.createOffer(); await pc.setLocalDescription(o); socket.emit("offer",{roomId,sdp:o}); }
async function makeAnswer(offer){ await pc.setRemoteDescription(new RTCSessionDescription(offer)); const a=await pc.createAnswer(); await pc.setLocalDescription(a); socket.emit("answer",{roomId,sdp:a}); }
async function acceptAnswer(ans){ await pc.setRemoteDescription(new RTCSessionDescription(ans)); }

// ---------- Signaling ----------
function initSignaling(){
  socket = io();

  socket.on("connect", ()=> setStatus("Connected to signaling"));
  socket.on("disconnect", ()=> setStatus("Disconnected from signaling"));

  socket.on("joined", ({ roomId:r }) => addMessage({ text:`Joined room: ${r}` }));

  socket.on("make_offer", async ()=>{
    isOfferer = true;
    if (!pc) createPeer();
    await makeOffer();
  });

  socket.on("await_offer", ()=>{
    isOfferer = false;
    if (!pc) createPeer();
  });

  socket.on("offer",  async ({ sdp }) => { isOfferer=false; if(!pc)createPeer(); await makeAnswer(sdp); });
  socket.on("answer", async ({ sdp }) => { await acceptAnswer(sdp); });
  socket.on("ice_candidate", async ({ candidate }) => { try { await pc.addIceCandidate(candidate); } catch {} });

  socket.on("room_full", ()=> addMessage({ text:"Room is full (2 peers max)." }));
}

// ---------- DataChannel messages ----------
function handleMsg(msg){
  if (msg.type === "chat") {
    addMessage({ user: msg.username || "Peer", text: msg.text, ts: msg._ts });
    return;
  }
  if (msg.type === "yt_load") { loadVideoNow(msg.videoId); return; }
  if (msg.type === "yt_play") { suppressEvents=true; safeSeek(msg.time||0); safePlay();  setTimeout(()=>suppressEvents=false,250); updateVideoState(); return; }
  if (msg.type === "yt_pause"){ suppressEvents=true; safeSeek(msg.time||0); safePause(); setTimeout(()=>suppressEvents=false,250); updateVideoState(); return; }
  if (msg.type === "yt_seek") { suppressEvents=true; safeSeek(msg.time||0); setTimeout(()=>suppressEvents=false,250); updateVideoState(); return; }
}

// ---------- UI actions ----------
connectBtn.onclick = () => {
  username = (nameInput?.value || "").trim() || `User-${Math.floor(Math.random()*1000)}`;

  // Auto-generate Room ID if empty
  roomId = (roomInput?.value || "").trim();
  if (!roomId) {
    roomId = generateRoomId();
    if (roomInput) roomInput.value = roomId;
    addMessage({ text: `Room created: ${window.location.origin}/?room=${roomId}` });
  }

  initSignaling();
  socket.emit("join", { roomId, username });
  setStatus(`Joining ${roomId}...`);
};

reconnectBtn && (reconnectBtn.onclick = () => {
  if (pc) pc.close();
  pc = null;
  initSignaling();
  socket.emit("join", { roomId, username });
  setStatus("Reconnecting...");
});

// Load/Add video (loads immediately here and tells peer to load too)
loadBtn.onclick = () => {
  const id = parseYouTubeId(ytUrlInput.value.trim());
  if (!id) return;
  loadVideoNow(id);                     // fix black screen locally
  sendDC({ type:"yt_load", videoId:id });// tell peer to load
};

playBtn.onclick  = () => { try{ player.playVideo(); }catch{} sendDC({ type:"yt_play",  time: player?.getCurrentTime?.() || 0 }); };
pauseBtn.onclick = () => { try{ player.pauseVideo(); }catch{} sendDC({ type:"yt_pause", time: player?.getCurrentTime?.() || 0 }); };
seekBtn.onclick  = () => { const t = Number(seekSec.value); if(Number.isFinite(t)){ safeSeek(t); sendDC({ type:"yt_seek", time:t }); }};

// Chat
sendBtn.onclick = () => {
  const text = (chatInput.value || "").trim();
  if (!text) return;
  addMessage({ user: username || "Me", text });
  sendDC({ type:"chat", text, username });
  chatInput.value = "";
};
chatInput.onkeydown = (e) => { if (e.key === "Enter") sendBtn.click(); };

// Pre-fill room from ?room= in URL
(() => {
  try {
    const u = new URL(location.href);
    const r = u.searchParams.get("room");
    if (r && roomInput) roomInput.value = r;
  } catch {}
})();
