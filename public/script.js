// script.js - Watch Together WebRTC + YouTube + Chat
let socket;
let pc;
let dataChannel;
let roomId;
let username;

// ---- ICE / STUN+TURN CONFIG ----
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

// UI elements
const connectBtn = document.getElementById("connectBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const roomInput = document.getElementById("roomInput");
const nameInput = document.getElementById("nameInput");
const statusSpan = document.getElementById("status");
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const videoUrlInput = document.getElementById("videoUrl");
const loadVideoBtn = document.getElementById("loadVideoBtn");

// YouTube Player
let player;
function onYouTubeIframeAPIReady() {
  player = new YT.Player("player", {
    events: {
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerStateChange(event) {
  if (!dataChannel || dataChannel.readyState !== "open") return;

  const state = event.data;
  if (state === YT.PlayerState.PLAYING) {
    sendMessage({ type: "video", action: "play", time: player.getCurrentTime() });
  } else if (state === YT.PlayerState.PAUSED) {
    sendMessage({ type: "video", action: "pause", time: player.getCurrentTime() });
  }
}

// --- WebRTC Connection Setup ---
function createPeer() {
  pc = new RTCPeerConnection(rtcConfig);

  // Data channel
  dataChannel = pc.createDataChannel("chat");
  dataChannel.onmessage = (event) => handleData(JSON.parse(event.data));
  dataChannel.onopen = () => setStatus("DataChannel: open");
  dataChannel.onclose = () => setStatus("DataChannel: closed");

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice_candidate", { roomId, candidate: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    addMessage({ user: "System", text: `ICE state: ${pc.iceConnectionState}` });
  };

  return pc;
}

// --- Messaging ---
function sendMessage(msg) {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify(msg));
  }
}

function handleData(msg) {
  if (msg.type === "chat") {
    addMessage({ user: msg.user, text: msg.text });
  } else if (msg.type === "video") {
    if (msg.action === "play") {
      player.seekTo(msg.time, true);
      player.playVideo();
    } else if (msg.action === "pause") {
      player.pauseVideo();
      player.seekTo(msg.time, true);
    }
  } else if (msg.type === "loadVideo") {
    player.loadVideoByUrl(msg.url);
  }
}

// --- Chat UI ---
function addMessage({ user, text }) {
  const p = document.createElement("p");
  p.innerHTML = `<strong>${user}:</strong> ${text}`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function setStatus(text) {
  statusSpan.textContent = text;
}

// --- Socket.io Signaling ---
function initSocket() {
  socket = io();

  socket.on("connect", () => setStatus("Connected to signaling"));
  socket.on("disconnect", () => setStatus("Disconnected from signaling"));

  socket.on("joined", async ({ offer }) => {
    if (offer) {
      pc = createPeer();
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { roomId, sdp: answer });
    } else {
      pc = createPeer();
      pc.ondatachannel = (event) => {
        dataChannel = event.channel;
        dataChannel.onmessage = (e) => handleData(JSON.parse(e.data));
        dataChannel.onopen = () => setStatus("DataChannel: open");
        dataChannel.onclose = () => setStatus("DataChannel: closed");
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", { roomId, sdp: offer });
    }
  });

  socket.on("offer", async ({ sdp }) => {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", { roomId, sdp: answer });
  });

  socket.on("answer", async ({ sdp }) => {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on("ice_candidate", async ({ candidate }) => {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error("Error adding received ice candidate", e);
    }
  });
}

// --- Event Listeners ---
connectBtn.onclick = () => {
  username = nameInput.value || "User";
  roomId = roomInput.value;
  if (!roomId) {
    alert("Enter a room ID");
    return;
  }
  initSocket();
  socket.emit("join", roomId, username);
};

sendBtn.onclick = () => {
  const text = chatInput.value;
  if (!text) return;
  sendMessage({ type: "chat", user: username, text });
  addMessage({ user: username, text });
  chatInput.value = "";
};

loadVideoBtn.onclick = () => {
  const url = videoUrlInput.value;
  if (url) {
    player.loadVideoByUrl(url);
    sendMessage({ type: "loadVideo", url });
  }
};
