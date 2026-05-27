# studious-robot

Cloud-first project with two workspaces:

| Path       | Purpose                                                  |
| ---------- | -------------------------------------------------------- |
| `mobile/`  | React Native app scaffolded with Expo                    |
| `server/`  | Node.js signaling server (Express + Socket.IO + `/health`) |

This project is designed to be developed **entirely in GitHub Codespaces**.
No local Android Studio, Xcode, or device toolchain is required — use the
[Expo Go](https://expo.dev/client) app on your phone to preview the mobile app.

---

## Prerequisites

- A GitHub Codespace for this repository (recommended). Locally, you need
  Node.js matching [`.nvmrc`](./.nvmrc) (run `nvm use`).
- The free **Expo Go** app installed on your iOS/Android device.

## First-time setup (in a Codespace)

```bash
# 1. Use the pinned Node version
nvm use

# 2. Install dependencies for each workspace
cd server && npm install && cd ..
cd mobile && npm install && cd ..
```

## Run the signaling server

```bash
cd server
npm run dev        # auto-restart on changes (or: npm start)
```

The server listens on port `3001` by default and exposes a health endpoint:

```bash
curl http://localhost:3001/health
# => {"status":"ok","service":"studious-robot-signaling", ...}
```

In Codespaces, forward port `3001` (the Ports panel handles this automatically
the first time the port is bound) and use the generated public URL to reach
`/health` from a browser.

## Run the Expo app

In a second Codespaces terminal:

```bash
cd mobile
npx expo start --tunnel
```

The Expo CLI prints a QR code and dev-server logs. Scan the QR code with
**Expo Go** on your phone — `--tunnel` ensures the bundle is reachable from
outside the Codespace without any local Android Studio setup.

> Tip: `npm start` inside `mobile/` is a shortcut for `expo start`. Use
> `--tunnel` from Codespaces so your device can connect across networks.

## Common npm scripts

Both workspaces expose a consistent script surface:

| Script         | `server/`                        | `mobile/`                        |
| -------------- | -------------------------------- | -------------------------------- |
| `npm start`    | Run the signaling server         | `expo start` (QR / dev server)   |
| `npm run dev`  | Run with `node --watch`          | —                                |
| `npm test`     | `node --test`                    | `jest --passWithNoTests`         |

## Verifying a fresh setup

A new contributor should be able to:

1. Open the repository in a Codespace.
2. Run `npm install` inside `server/` and `mobile/`.
3. `cd server && npm start` and see `[signaling] listening on http://0.0.0.0:3001`.
4. `curl http://localhost:3001/health` and receive `{"status":"ok", ...}`.
5. In another terminal, `cd mobile && npx expo start --tunnel` and scan the QR
   code with Expo Go on a phone — without installing Android Studio locally.
