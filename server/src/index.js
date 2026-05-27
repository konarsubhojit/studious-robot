'use strict';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

/**
 * Build the Express app and HTTP/Socket.IO server.
 *
 * Exported as a factory so tests can spin up an isolated instance on an
 * ephemeral port without starting the production listener.
 */
function createServer() {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'studious-robot-signaling',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  const httpServer = http.createServer(app);
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : '*';
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
  });

  io.on('connection', (socket) => {
    // Minimal signaling relay: clients join a room and broadcast messages to peers.
    socket.on('join', (room) => {
      if (typeof room === 'string' && room.length > 0) {
        socket.join(room);
        socket.to(room).emit('peer-joined', { id: socket.id });
      }
    });

    socket.on('signal', ({ room, payload } = {}) => {
      if (typeof room === 'string' && room.length > 0) {
        socket.to(room).emit('signal', { from: socket.id, payload });
      }
    });

    socket.on('disconnect', () => {
      // Rooms are cleaned up automatically by Socket.IO.
    });
  });

  return { app, httpServer, io };
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3001;
  const host = process.env.HOST || '0.0.0.0';
  const { httpServer } = createServer();
  httpServer.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[signaling] listening on http://${host}:${port}`);
    // eslint-disable-next-line no-console
    console.log(`[signaling] health endpoint: http://${host}:${port}/health`);
  });
}
