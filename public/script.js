// public/script.js
// WebRTC (data channel) + Socket.io signaling + YouTube IFrame sync
// Includes: auto room IDs, typing indicator, playlist, reconnect, yt_load fix

let socket, pc, dataChannel;
let isOfferer = false, roomId = null, username = null;

// YouTube
let player, playerReady = false, suppressEvents = false;

// UI refs
const connectBtn = document.getElementById("connectBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const loadBtn = document.getElementById("loadBtn");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const seekBtn = document.getElementById("seekBtn");
const seekSec = document.getElementById("seekSec");
const ytUrlInput = document.getElementById("ytUrl");
const roomInput = document.getElementById("roomId");
const usernameInput = document.getElementById("username");
const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const dcStateEl = document.getElementById("dcState");
const videoStateEl = document.getElementById("videoState");
const videoList = document.getElementById("videoList");
let typingTimeout;
let playlist = [];

// STUN (add TURN later if needed)
const rtcConfig = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

// ---------- Utils ----------
const setStatus = (t) => (statusEl.innerHTML = `<code>${t}</code>`);
const setDCState = (t) => (dcStateEl.textContent = `DataChannel: ${t}`);
function addMessage({ user = "System", text, ts = Date.now() }) {
  const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<div class="meta">${time} • ${user}</div><div>${text}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const p = u.pathname.split("/");
    if (p.includes("embed")) return p[p.indexOf("embed") + 1];
    if (p.includes("shorts")) return p[p.indexOf("shorts") + 1];
  } catch {}
  return /^[\w-]{11}$/.test(url) ? url : null;
}

// ---------- YouTube ----------
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    height: "390",
    width: "640",
    videoId: "",
    playerVars: {
      playsinline: 1,
      rel: 0,
      // IMPORTANT on hosted environments:
      origin: window.location.origin,
      host: "https://www.youtube.com",
    },
    events: {
      onReady: () => { playerReady = true; updateVideoStateLabel(); },
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  });
};

function onPlayerError(e) {
  const map = {
    2: "Bad URL/ID",
    5: "HTML5 player error (refresh)",
    100: "Removed/Private",
    101: "Embedding disabled",
    150: "Embedding disabled",
  };
  addMessage({ user: "System", text: `YouTube error: ${map[e.data] || e.data}` });
}

function onPlayerStateChange(e) {
  if (!dataChannel || dataChannel.readyState !== "open") return;
  if (suppressEvents) return;
  const t = safeTime();
  if (e.data === YT.PlayerState.PLAYING) sendDC({ type: "yt_play", time: t });
  if (e.data === YT.PlayerState.PAUSED)  sendDC({ type: "yt_pause", time: t });
  updateVideoStateLabel();
}

function updateVideoStateLabel() {
  if (!playerReady) { videoStateEl.textContent = "Player: not ready"; return; }
  const s = player.getPlayerState?.();
  const name = { [-1]:"unstarted", 0:"ended", 1:"playing", 2:"paused", 3:"buffering", 5:"cued" }[s] || "?";
  videoStateEl.textContent = `Player: ${name} @ ${safeTime().toFixed(1)}s`;
}

function safePlay(){ try{ player.playVideo(); }catch{} }
function safePause(){ try{ player.pauseVideo(); }catch{} }
function safeSeekTo(t){ try{ player.seekTo(t, true); }catch{} }
function safeTime(){ try{ return player.getCurrentTime(); }catch{ return 0; } }
function loadVideoByIdNow(id){ if(playerReady) { try{ player.loadVideoById(id); }catch{} } } // ensures frame paints (fix)

// ---------- WebRTC ----------
function createPeer() {
  pc = new RTCPeerConnection(rtcConfig);
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit("ice_candidate", { roomId, candidate: e.candidate }); };
  if (isOfferer) {
    dataChannel = pc.createDataChannel("chat-sync");
    setupDC();
  } else {
    pc.ondatachannel = (e) => { dataChannel = e.channel; setupDC(); };
  }
  return pc;
}

function setupDC() {
  dataChannel.onopen = () => { setDCState("open"); addMessage({ text:"Data channel opened." }); sendDC({ type:"hello", username }); };
  dataChannel.onclose = () => setDCState("closed");
  dataChannel.onmessage = (e) => handleMsg(JSON.parse(e.data));
}

function sendDC(obj){ if(dataChannel?.readyState==="open") dataChannel.send(JSON.stringify({ ...obj, _ts: Date.now() })); }

async function makeOffer(){ const o=await pc.createOffer(); await pc.setLocalDescription(o); socket.emit("offer",{roomId,sdp:o}); }
async function makeAnswer(offer){ await pc.setRemoteDescription(new RTCSessionDescription(offer)); const a=await pc.createAnswer(); await pc.setLocalDescription(a); socket.emit("answer",{roomId,sdp:a}); }
async function acceptAnswer(ans){ await pc.setRemoteDescription(new RTCSessionDescription(ans)); }

// ---------- Signaling ----------
function initSignaling(){
  socket = io();
  socket.on("connect",()=>setStatus("Connected to signaling"));
  socket.on("joined",({roomId:r})=>addMessage({text:`Joined room: ${r}`}));
  socket.on("make_offer",async()=>{isOfferer=true; if(!pc)createPeer(); await makeOffer();});
  socket.on("await_offer",()=>{isOfferer=false; if(!pc)createPeer();});
  socket.on("offer",async({sdp})=>{isOfferer=false; if(!pc)createPeer(); await makeAnswer(sdp);});
  socket.on("answer",async({sdp})=>await acceptAnswer(sdp));
  socket.on("ice_candidate",async({candidate})=>{try{await pc.addIceCandidate(candidate);}catch{}});
  socket.on("room_full",()=>addMessage({text:"Room full"}));
}

// ---------- DataChannel messages ----------
function handleMsg(msg){
  // Chat & typing
  if(msg.type==="chat"){ addMessage({user:msg.username||"Peer",text:msg.text,ts:msg._ts}); return; }
  if(msg.type==="hello"){ addMessage({text:`${msg.username} joined.`}); return; }
  if(msg.type==="typing"){ dcStateEl.textContent=`${msg.username} is typing...`; return; }
  if(msg.type==="stop_typing"){ setDCState("open"); return; }

  // NEW: explicit load so both sides paint the frame immediately
  if(msg.type==="yt_load"){ loadVideoByIdNow(msg.videoId); return; }

  // Playback sync
  if(msg.type==="yt_play"){ suppressEvents = true; if(typeof msg.time==="number") safeSeekTo(msg.time); safePlay();  setTimeout(()=>suppressEvents=false, 250); return; }
  if(msg.type==="yt_pause"){ suppressEvents = true; if(typeof msg.time==="number") safeSeekTo(msg.time); safePause(); setTimeout(()=>suppressEvents=false, 250); return; }
  if(msg.type==="yt_seek"){  suppressEvents = true; safeSeekTo(msg.time||0); setTimeout(()=>suppressEvents=false, 250); return; }
}

// ---------- UI ----------
connectBtn.onclick = () => {
  let r = (roomInput.value || "").trim();
  if(!r){
    r = Math.random().toString(36).substring(2,8);
    roomInput.value = r;
    addMessage({ text:`Room created: ${location.origin}/?room=${r}` });
  }
  roomId = r;
  username = (usernameInput.value || "").trim() || `User-${Math.floor(Math.random()*1000)}`;
  initSignaling();
  socket.emit("join", { roomId, username });
  setStatus(`Joining ${roomId}...`);
};

reconnectBtn.onclick = () => {
  if (pc) pc.close();
  pc = null;
  initSignaling();
  socket.emit("join", { roomId, username });
  setStatus("Reconnecting...");
};

// Add / Playlist
loadBtn.onclick = () => {
  const id = parseYouTubeId(ytUrlInput.value.trim());
  if(!id) return;

  // local: LOAD immediately so you don't see black frame
  loadVideoByIdNow(id);

  // optional: push to playlist UI
  const li = document.createElement("li");
  li.textContent = ytUrlInput.value.trim();
  li.style.cursor = "pointer";
  li.onclick = () => {
    loadVideoByIdNow(id);
    sendDC({ type:"yt_load", videoId:id });
  };
  videoList.appendChild(li);
  playlist.push(id);

  // remote: tell peer to LOAD the same video
  sendDC({ type:"yt_load", videoId:id });
};

playBtn.onclick  = () => { try{ player.playVideo(); }catch{} sendDC({ type:"yt_play",  time: safeTime() }); };
pauseBtn.onclick = () => { try{ player.pauseVideo(); }catch{} sendDC({ type:"yt_pause", time: safeTime() }); };
seekBtn.onclick  = () => { const t = Number(seekSec.value); if(Number.isFinite(t)){ safeSeekTo(t); sendDC({ type:"yt_seek", time:t }); }};

chatInput.onkeydown = (e) => { if (e.key === "Enter") sendChat(); };
sendBtn.onclick = sendChat;
function sendChat(){
  const text = chatInput.value.trim();
  if(!text) return;
  addMessage({ user: username || "Me", text });
  sendDC({ type:"chat", text, username });
  chatInput.value = "";
}
chatInput.oninput = () => {
  sendDC({ type:"typing", username });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => sendDC({ type:"stop_typing", username }), 1000);
};

// Pre-fill room from URL
(() => {
  try{
    const u = new URL(location.href);
    const r = u.searchParams.get("room");
    if (r) roomInput.value = r;
  }catch{}
})();
