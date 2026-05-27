# Signaling Server

Express + Socket.IO signaling service for the studious-robot project.

## Requirements
- Node.js (see repo root `.nvmrc`)

## Setup
```bash
cd server
npm install
```

## Run
```bash
npm start          # production
npm run dev        # watch mode
npm test           # node --test
```

The server listens on `PORT` (default `3001`) and exposes:
- `GET /health` — liveness/health probe returning JSON `{ status: "ok", ... }`
- Socket.IO endpoint for WebRTC signaling (see events below)

### Socket.IO signaling events

Rooms hold at most **2 participants**. All relay events are forwarded only to the other peer in the same room.

#### Client → Server

| Event           | Payload                              | Description                                              |
| --------------- | ------------------------------------ | -------------------------------------------------------- |
| `join-room`     | `roomId: string`                     | Join a room. Rejected with `room-full` if already at 2. |
| `offer`         | `{ roomId, sdp }`                    | Relay an SDP offer to the other peer.                    |
| `answer`        | `{ roomId, sdp }`                    | Relay an SDP answer to the other peer.                   |
| `ice-candidate` | `{ roomId, candidate }`              | Relay an ICE candidate to the other peer.                |

#### Server → Client

| Event           | Payload                              | Description                                              |
| --------------- | ------------------------------------ | -------------------------------------------------------- |
| `peer-joined`   | `{ id: socketId }`                   | Emitted to the existing peer when a second user joins.   |
| `room-full`     | `{ roomId }`                         | Emitted to the joining client when the room is full.     |
| `offer`         | `{ from: socketId, sdp }`            | Forwarded offer from the other peer.                     |
| `answer`        | `{ from: socketId, sdp }`            | Forwarded answer from the other peer.                    |
| `ice-candidate` | `{ from: socketId, candidate }`      | Forwarded ICE candidate from the other peer.             |
| `peer-left`     | `{ id: socketId }`                   | Emitted to the remaining peer when the other disconnects.|

### Environment variables

| Name          | Default     | Description                                                       |
| ------------- | ----------- | ----------------------------------------------------------------- |
| `PORT`        | `3001`      | TCP port to listen on                                             |
| `HOST`        | `0.0.0.0`   | Bind address                                                      |
| `CORS_ORIGIN` | `*` (dev)   | Comma-separated allow-list for Socket.IO CORS. Set to your app origin(s) in production. |
