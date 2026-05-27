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
- Socket.IO endpoint for signaling (`join`, `signal` events)

### Environment variables

| Name          | Default     | Description                                                       |
| ------------- | ----------- | ----------------------------------------------------------------- |
| `PORT`        | `3001`      | TCP port to listen on                                             |
| `HOST`        | `0.0.0.0`   | Bind address                                                      |
| `CORS_ORIGIN` | `*` (dev)   | Comma-separated allow-list for Socket.IO CORS. Set to your app origin(s) in production. |
