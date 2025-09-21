// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.on("join", ({ roomId, username }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const num = room ? room.size : 0;

    if (num >= 2) {
      socket.emit("room_full");
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username || `User-${socket.id.slice(0, 4)}`;
    socket.emit("joined", { roomId, id: socket.id });

    // If room now has 2 members, assign roles
    const roomNow = io.sockets.adapter.rooms.get(roomId);
    if (roomNow && roomNow.size === 2) {
      const ids = Array.from(roomNow.values());
      const offererId = ids[0];
      const answererId = ids[1];

      io.to(offererId).emit("make_offer", { peerId: answererId });
      io.to(answererId).emit("await_offer", { peerId: offererId });
      io.to(roomId).emit("peer_ready");
    }
  });

  socket.on("offer", ({ roomId, sdp }) => socket.to(roomId).emit("offer", { sdp }));
  socket.on("answer", ({ roomId, sdp }) => socket.to(roomId).emit("answer", { sdp }));
  socket.on("ice_candidate", ({ roomId, candidate }) =>
    socket.to(roomId).emit("ice_candidate", { candidate })
  );

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit("peer_left");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Signaling server running on http://localhost:${PORT}`)
);
