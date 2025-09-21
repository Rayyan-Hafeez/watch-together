// script.js
let socket, pc, dataChannel;
let isOfferer = false, roomId = null, username = null;
let player, playerReady = false, suppressEvents = false, lastRemoteSeekTs = 0;
let typingTimeout;

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
let playlist = [];

const rtcConfig = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
const setStatus = (t) => (statusEl.innerHTML = `<code>${t}</code>`);
const setDCState = (t) => (dcStateEl.textContent = `DataChannel: ${t}`);
const addMessage = ({ user = "System", text, ts = Date.now() }) => {
  const d = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<div class="meta">${d} • ${user}</div><div>${text}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
};

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

// ---- YouTube ----
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    videoId: "",
    events: { onReady: () => (playerReady = true), onStateChange: onPlayerStateChange },
  });
};
function onPlayerStateChange(e) {
  if (!dataChannel || dataChannel.readyState !== "open" || suppressEvents) return;
  const t = player.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING) sendDC({ type: "yt_play", time: t });
  if (e.data === YT.PlayerState.PAUSED) sendDC({ type: "yt_pause", time: t });
}
function safePlay(){ try{player.playVideo();}catch{} }
function safePause(){ try{player.pauseVideo();}catch{} }
function safeSeekTo(t){ try{player.seekTo(t,true);}catch{} }
function safeTime(){ try{return player.getCurrentTime();}catch{return 0;} }

// ---- WebRTC ----
function createPeer() {
  pc = new RTCPeerConnection(rtcConfig);
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit("ice_candidate", { roomId, candidate:e.candidate }); };
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

// ---- Signaling ----
function initSignaling(){
  socket = io();
  socket.on("connect",()=>setStatus("Connected to signaling"));
  socket.on("joined",({roomId:r})=>addMessage({text:`Joined room: ${r}`}));
  socket.on("make_offer",async()=>{isOfferer=true; if(!pc)createPeer(); await makeOffer();});
  socket.on("await_offer",()=>{isOfferer=false; if(!pc)createPeer();});
  socket.on("offer",async({sdp})=>{isOfferer=false;if(!pc)createPeer();await makeAnswer(sdp);});
  socket.on("answer",async({sdp})=>await acceptAnswer(sdp));
  socket.on("ice_candidate",async({candidate})=>{try{await pc.addIceCandidate(candidate);}catch{}});
  socket.on("room_full",()=>addMessage({text:"Room full"}));
}

// ---- Messages ----
function handleMsg(msg){
  if(msg.type==="chat"){ addMessage({user:msg.username||"Peer",text:msg.text,ts:msg._ts}); return; }
  if(msg.type==="hello"){ addMessage({text:`${msg.username} joined.`}); return; }
  if(msg.type==="typing"){ dcStateEl.textContent=`${msg.username} is typing...`; return; }
  if(msg.type==="stop_typing"){ setDCState("open"); return; }
  if(msg.type==="yt_snapshot"){ if(msg.videoId) loadVideo(msg.videoId); safeSeekTo(msg.time||0); if(msg.state===1) safePlay(); if(msg.state===2) safePause(); return; }
  if(msg.type==="yt_play"){ safeSeekTo(msg.time); safePlay(); }
  if(msg.type==="yt_pause"){ safeSeekTo(msg.time); safePause(); }
  if(msg.type==="yt_seek"){ safeSeekTo(msg.time); }
}
function loadVideo(id){ if(playerReady) player.cueVideoById(id); }

// ---- UI ----
connectBtn.onclick=()=>{
  let r=(roomInput.value||"").trim();
  if(!r){ r=Math.random().toString(36).substring(2,8); roomInput.value=r; addMessage({text:`Room created: ${location.origin}/?room=${r}`}); }
  roomId=r; username=(usernameInput.value||"").trim()||`User-${Math.floor(Math.random()*1000)}`;
  initSignaling(); socket.emit("join",{roomId,username}); setStatus(`Joining ${roomId}...`);
};
reconnectBtn.onclick=()=>{ if(pc)pc.close(); pc=null; initSignaling(); socket.emit("join",{roomId,username}); setStatus("Reconnecting..."); };
loadBtn.onclick=()=>{ const id=parseYouTubeId(ytUrlInput.value.trim()); if(!id)return; playlist.push(id); const li=document.createElement("li"); li.textContent=ytUrlInput.value; li.onclick=()=>{loadVideo(id); sendDC({type:"yt_snapshot",videoId:id,time:0,state:5});}; videoList.appendChild(li); loadVideo(id); sendDC({type:"yt_snapshot",videoId:id,time:0,state:5}); };
playBtn.onclick=()=>{ safePlay(); sendDC({type:"yt_play",time:safeTime()}); };
pauseBtn.onclick=()=>{ safePause(); sendDC({type:"yt_pause",time:safeTime()}); };
seekBtn.onclick=()=>{ const t=Number(seekSec.value); if(isFinite(t)){ safeSeekTo(t); sendDC({type:"yt_seek",time:t}); } };
chatInput.onkeydown=(e)=>{ if(e.key==="Enter") sendChat(); };
chatInput.oninput=()=>{ sendDC({type:"typing",username}); clearTimeout(typingTimeout); typingTimeout=setTimeout(()=>sendDC({type:"stop_typing",username}),1000); };
sendBtn.onclick=sendChat;
function sendChat(){ const text=chatInput.value.trim(); if(!text)return; addMessage({user:username,text}); sendDC({type:"chat",text,username}); chatInput.value=""; }
(() => { try{const u=new URL(location.href);const r=u.searchParams.get("room");if(r)roomInput.value=r;}catch{} })();
