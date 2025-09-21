// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*"},
  transports: ["websocket", "polling"],
  pingTimeout: 30000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("join", ({ roomId, username }) => {
    try {
      if (!roomId) return socket.emit("error_msg", "No roomId");
      const room = io.sockets.adapter.rooms.get(roomId);
      const size = room ? room.size : 0;
      if (size >= 2) {
        socket.emit("room_full");
        return;
      }
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.username = username || `User-${socket.id.slice(0,4)}`;
      console.log(`socket ${socket.id} joined ${roomId}, size before: ${size}`);

      socket.emit("joined", { roomId });

      const after = io.sockets.adapter.rooms.get(roomId);
      if (after && after.size === 2) {
        const ids = Array.from(after.values());
        // Choose first to make the offer
        io.to(ids[0]).emit("make_offer", { peerId: ids[1] });
        io.to(ids[1]).emit("await_offer", { peerId: ids[0] });
        io.to(roomId).emit("peer_ready");
      }
    } catch (e) {
      console.error("join error", e);
    }
  });

  socket.on("offer", ({ roomId, sdp }) => {
    socket.to(roomId).emit("offer", { sdp });
  });

  socket.on("answer", ({ roomId, sdp }) => {
    socket.to(roomId).emit("answer", { sdp });
  });

  socket.on("ice_candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice_candidate", { candidate });
  });

  socket.on("disconnect", () => {
    const r = socket.data?.roomId;
    if (r) {
      socket.to(r).emit("peer_left");
    }
    console.log("socket disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Signaling server on http://${HOST}:${PORT}`);
});
