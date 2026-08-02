const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const SYNC_TICK_MS = 5000;
const DRIFT_THRESHOLD_MS = 800;
const ROOM_GC_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// ── Ensure uploads directory ────────────────────────────────────────────────
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer setup ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, crypto.randomUUID() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ── Room Manager ────────────────────────────────────────────────────────────
class RoomManager {
  constructor() { this._rooms = new Map(); }

  _generateCode() {
    for (let i = 0; i < 10; i++) {
      let code = '';
      for (let j = 0; j < ROOM_CODE_LENGTH; j++) {
        code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      }
      if (!this._rooms.has(code)) return code;
    }
    throw new Error('Failed to generate unique room code');
  }

  create() {
    const code = this._generateCode();
    const room = {
      code,
      hostId: null,
      video: null,        // { videoId, name, size }
      state: {
        playing: false,
        positionMs: 0,
        updatedAt: Date.now(),
        rate: 1.0
      },
      createdAt: Date.now(),
      viewers: new Map()  // socketId -> { name }
    };
    this._rooms.set(code, room);
    return room;
  }

  get(code) { return this._rooms.get(code) || null; }

  /** Compute current playback position from virtual clock */
  positionAt(room) {
    const s = room.state;
    if (!s.playing) return s.positionMs;
    return s.positionMs + (Date.now() - s.updatedAt) * s.rate;
  }

  /** Get a full snapshot for new joiners */
  snapshot(room) {
    return {
      playing: room.state.playing,
      positionMs: this.positionAt(room),
      updatedAt: Date.now(),
      rate: room.state.rate
    };
  }

  /** Apply a playback command (play/pause/seek) */
  applyPlayback(room, { action, positionMs }) {
    const s = room.state;
    s.positionMs = positionMs;
    s.updatedAt = Date.now();
    s.playing = action === 'play';
  }

  /** Assign video to room (called after upload) */
  setVideo(room, video) {
    room.video = video;
  }

  /** Add viewer, return snapshot + video info */
  joinViewer(room, socketId, name) {
    room.viewers.set(socketId, { name });
    return {
      snapshot: this.snapshot(room),
      video: room.video,
      viewerCount: room.viewers.size
    };
  }

  /** Remove viewer */
  leaveViewer(room, socketId) {
    room.viewers.delete(socketId);
    return room.viewers.size;
  }

  /** Record new host */
  setHost(room, socketId) {
    room.hostId = socketId;
  }

  /** Check if socket is the host */
  isHost(room, socketId) { return room.hostId === socketId; }

  /** Garbage-collect empty rooms */
  gc() {
    const now = Date.now();
    for (const [code, room] of this._rooms) {
      if (room.viewers.size === 0 && !room.hostId &&
          (now - room.createdAt) > ROOM_GC_TIMEOUT_MS) {
        // Delete uploaded video file (skip bilibili — no local file)
        if (room.video && room.video.type !== 'bilibili') {
          const filePath = room.video.filename
            ? path.join(UPLOADS_DIR, room.video.filename)
            : path.join(UPLOADS_DIR, room.video.videoId + path.extname(room.video.name));
          try { fs.unlinkSync(filePath); } catch (_) { /* already deleted */ }
        }
        this._rooms.delete(code);
      }
    }
  }

  delete(code) {
    const room = this._rooms.get(code);
    if (room && room.video && room.video.type !== 'bilibili') {
      const filePath = room.video.filename
        ? path.join(UPLOADS_DIR, room.video.filename)
        : path.join(UPLOADS_DIR, room.video.videoId + path.extname(room.video.name));
      try { fs.unlinkSync(filePath); } catch (_) { /* already deleted */ }
    }
    this._rooms.delete(code);
  }

  get size() { return this._rooms.size; }
}

const rooms = new RoomManager();

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ────────────────────────────────────────────────────────────────

// Create room
app.post('/api/rooms', (_req, res) => {
  const room = rooms.create();
  res.json({ code: room.code });
});

// Delete room (host only — deletes video file too)
app.delete('/api/rooms/:code', (req, res) => {
  const code = req.params.code?.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  rooms.delete(code);
  res.json({ ok: true });
});

// Upload video
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

  const videoId = path.parse(req.file.filename).name; // UUID without extension
  const video = {
    videoId,
    name: req.file.originalname,
    size: req.file.size,
    filename: req.file.filename
  };

  res.json(video);
});

// Serve video by videoId (UUID lookup — no path traversal)
app.get('/videos/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  // Find the file in uploads directory
  const files = fs.readdirSync(UPLOADS_DIR);
  const found = files.find(f => f.startsWith(videoId));
  if (!found) return res.status(404).send('Video not found');

  const filePath = path.join(UPLOADS_DIR, found);
  res.sendFile(filePath, { acceptRanges: true });
});

// Share URL auto-join route
app.get('/w/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── LAN IP detection (startup banner) ───────────────────────────────────────
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// ── Socket.IO ───────────────────────────────────────────────────────────────
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

// Periodic sync tick
const syncTickInterval = setInterval(() => {
  for (const [code, room] of rooms._rooms) {
    if (room.state.playing && room.hostId) {
      const positionMs = rooms.positionAt(room);
      io.to(code).emit('sync', {
        playing: true,
        positionMs,
        updatedAt: Date.now()
      });
    }
  }
}, SYNC_TICK_MS);

// Periodic GC
const gcInterval = setInterval(() => rooms.gc(), 10 * 60 * 1000);

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentRole = null;

  socket.on('room:join', (data, ack) => {
    const { code, role, name } = data;
    const room = rooms.get(code?.toUpperCase());

    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: '房间不存在' });
      return;
    }

    if (role === 'host') {
      if (room.hostId && room.hostId !== socket.id) {
        if (typeof ack === 'function') ack({ ok: false, error: '该房间已有主持人' });
        return;
      }
      rooms.setHost(room, socket.id);
      currentRole = 'host';
    } else {
      currentRole = 'viewer';
      const { snapshot, video, viewerCount } = rooms.joinViewer(room, socket.id, name || 'Guest-' + socket.id.slice(-4));
      socket.join(code);
      currentRoom = code;

      if (typeof ack === 'function') {
        ack({
          ok: true,
          role: 'viewer',
          state: snapshot,
          video,
          viewerCount
        });
      }

      // Notify room of viewer count change
      io.to(code).emit('viewer:joined', { count: viewerCount });
      return;
    }

    socket.join(code);
    currentRoom = code;

    if (typeof ack === 'function') {
      ack({
        ok: true,
        role: 'host',
        state: rooms.snapshot(room),
        video: room.video,
        viewerCount: room.viewers.size
      });
    }
  });

  // ── Host-only playback controls ──────────────────────────────────────────

  function handleControl(action, data) {
    if (!currentRoom || currentRole !== 'host') return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    rooms.applyPlayback(room, { action, positionMs: data.positionMs });

    // Broadcast to everyone except sender
    socket.to(currentRoom).emit(action, {
      positionMs: data.positionMs,
      updatedAt: Date.now()
    });
  }

  socket.on('play', (data) => handleControl('play', data));
  socket.on('pause', (data) => handleControl('pause', data));
  socket.on('seek', (data) => handleControl('seek', data));

  // ── Video assignment (host sets video after upload) ──────────────────────
  socket.on('video:set', (data) => {
    if (!currentRoom || currentRole !== 'host') return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    rooms.setVideo(room, data);
    // Broadcast to all viewers
    io.to(currentRoom).emit('video:ready', data);
  });

  // ── Leave room ──────────────────────────────────────────────────────────
  socket.on('leave-room', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (currentRole === 'host') {
      room.hostId = null;
      room.state.playing = false;
      io.to(currentRoom).emit('host:left', { reason: 'host_left' });
    } else {
      const count = rooms.leaveViewer(room, socket.id);
      io.to(currentRoom).emit('viewer:left', { count });
    }

    socket.leave(currentRoom);
    currentRoom = null;
    currentRole = null;
  });

  // ── Delete room (host only) ──────────────────────────────────────────────
  socket.on('room:delete', () => {
    if (!currentRoom || currentRole !== 'host') return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // Notify all viewers before deletion
    io.to(currentRoom).emit('host:left', { reason: 'room_deleted' });
    // Disconnect all viewers in the room
    const roomSockets = io.sockets.adapter.rooms.get(currentRoom);
    if (roomSockets) {
      roomSockets.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) s.leave(currentRoom);
      });
    }
    // Delete room (includes video file cleanup)
    rooms.delete(currentRoom);
  });

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (currentRole === 'host') {
      room.hostId = null;
      room.state.playing = false;
      socket.to(currentRoom).emit('host:left', { reason: 'disconnected' });
    } else {
      const count = rooms.leaveViewer(room, socket.id);
      io.to(currentRoom).emit('viewer:left', { count });
    }

    currentRoom = null;
    currentRole = null;
  });
});

// ── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       🎬  OnlineAV — 局域网同步看视频           ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  本机访问:  http://localhost:${PORT}              ║`);
  console.log(`║  局域网访问: http://${lanIp}:${PORT}              ${' '.repeat(Math.max(0, 10 - String(lanIp).length))}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  分享房间链接给朋友即可同步看视频                ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});

// ── Cleanup ─────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  clearInterval(syncTickInterval);
  clearInterval(gcInterval);
  server.close();
  process.exit(0);
});
