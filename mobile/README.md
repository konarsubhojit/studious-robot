# Mobile (Expo)

React Native app scaffolded with Expo for the studious-robot project.

## Requirements
- Node.js (see repo root `.nvmrc`)
- Expo Go on your physical device (recommended for Codespaces workflow)

## Setup
```bash
cd mobile
npm install
```

## Run in Codespaces
```bash
npm start          # alias for `expo start`
# or explicitly for tunnel (recommended from Codespaces):
npx expo start --tunnel
```

Scan the printed QR code with the Expo Go app on your device. No local Android
Studio / Xcode installation is required for development.

## Other scripts
```bash
npm run android    # open on connected Android device/emulator
npm run ios        # open on iOS simulator (macOS)
npm run web        # open web preview
npm test           # jest (passes with no tests by default)
```
