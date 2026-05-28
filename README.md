# studious-robot

Cloud-first project with two folders:

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

# 2. Install dependencies for each folder
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

Both folders expose a consistent script surface:

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

---

## Cloud delivery (Phase 5)

### EAS Android builds

[`mobile/eas.json`](./mobile/eas.json) defines three build profiles:

| Profile       | Distribution | Android artifact | Use case                              |
| ------------- | ------------ | ---------------- | ------------------------------------- |
| `development` | internal     | APK (debug)      | Dev-client builds for active dev work |
| `preview`     | internal     | APK (release)    | Ad-hoc testing / QA                   |
| `production`  | store        | AAB              | Google Play submission                |

**Prerequisites:**

- An [Expo account](https://expo.dev) and the EAS CLI: `npm install -g eas-cli`
- Log in: `eas login`
- If you fork this repository, update the following fields in `mobile/app.json`
  to match your own Expo account and application identifiers:
  - `expo.owner` → your Expo account username
  - `expo.android.package` → e.g. `com.yourname.studiousrobot`
  - `expo.ios.bundleIdentifier` → e.g. `com.yourname.studiousrobot`

**Trigger a preview APK build (no local Android toolchain required):**

```bash
cd mobile
eas build -p android --profile preview
```

The EAS dashboard shows build logs; the finished APK download link is available
there and via `eas build:list`.

### Render signaling backend

[`render.yaml`](./render.yaml) configures a Render Web Service that:

- Uses the `server/` sub-directory as the root.
- Runs `npm install --omit=dev` on build and `npm start` to serve.
- Exposes `/health` as the health-check path.

**One-time Render setup:**

1. Connect the repository to [Render](https://render.com) and choose
   *"Use render.yaml"* when creating the service.
2. In the Render dashboard → Environment, set `CORS_ORIGIN` to your Expo app's
   origin (e.g. the Expo public URL or your custom domain).
3. Copy the **Deploy Hook URL** from the Render service settings and save it as a
   repository secret named `RENDER_DEPLOY_HOOK_URL` in GitHub.

Once deployed, verify with:

```bash
curl https://<your-render-service>.onrender.com/health
# => {"status":"ok","service":"studious-robot-signaling", ...}
```

### GitHub Actions — Backend CI & Deploy

[`.github/workflows/backend-ci.yml`](./.github/workflows/backend-ci.yml) runs
automatically on every pull request and push to `main` that touches `server/`:

1. **test** job — installs deps, runs `npm test` (Node built-in test runner).
2. **deploy** job — on `main` push only, calls the Render deploy hook
   (`RENDER_DEPLOY_HOOK_URL` secret) so the live service is always up to date.

### Release flow (PR merge → APK + live backend)

```
feature branch
    │
    ▼
Pull Request opened
    │  └─ GitHub Actions: backend-ci.yml runs "test" job
    │
    ▼
Merge to main
    │  ├─ GitHub Actions: "deploy" job triggers Render redeploy
    │  │      └─ Render builds from main → /health is live within ~2 min
    │  │
    │  └─ Developer runs: eas build -p android --profile preview
    │         └─ EAS cloud builds APK → download from Expo dashboard
    ▼
QA installs APK, points app to Render URL, tests end-to-end
```
