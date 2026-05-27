# studious-robot

## GitHub Issue Backlog: 2-Person Android Video Calling App

### Issue 1
**Title:** [Phase 1] Scaffold Expo app, signaling server, and cloud-first workflow baseline  
**Labels:** enhancement, frontend, backend, infrastructure  
**Description:**  
> Initialize the React Native (Expo) app and Node.js signaling server in a structure that works fully in GitHub Codespaces, and document cloud-only development conventions for a 2-person team.

**Tasks:**
- [ ] Create Expo app scaffold and backend folder layout (`mobile/`, `server/`).
- [ ] Initialize Node.js server with `socket.io` and basic health endpoint.
- [ ] Add root README setup steps for Codespaces-only development.
- [ ] Add `.nvmrc` and consistent npm scripts for both projects.

**Acceptance Criteria:**
- Expo app starts in Codespaces (`npx expo start`) and shows QR/dev server logs.
- Node server starts from Codespaces terminal and exposes `/health`.
- A new contributor can follow README and run both services without local Android Studio.

**Technical Notes:**
- Commands (Codespaces-compatible):
  - `npx create-expo-app@latest mobile`
  - `mkdir server && cd server && npm init -y && npm i express socket.io cors`
- Keep environment values in `.env.example` only (no secrets committed).

---

### Issue 2
**Title:** [Phase 2] Implement 2-user room signaling with offer/answer and ICE relay  
**Labels:** enhancement, backend, realtime  
**Description:**  
> Build the signaling server contract for exactly two participants per room, including SDP and ICE relay events needed for WebRTC negotiation.

**Tasks:**
- [ ] Add Socket.IO handlers for `join-room`, `offer`, `answer`, `ice-candidate`, and disconnect cleanup.
- [ ] Enforce max room size of 2 and emit `room-full` event to additional clients.
- [ ] Relay signaling payloads only to the peer in the same room.
- [ ] Add server-side logging for join/leave/relay events.

**Acceptance Criteria:**
- First 2 users join the same room successfully; 3rd user receives `room-full`.
- Offer/answer and ICE events are relayed to the other peer in the room only.
- On disconnect, remaining peer receives notification and room state is updated.

**Technical Notes:**
- Suggested event payload shape:
  - `{ roomId, sdp }` for `offer`/`answer`
  - `{ roomId, candidate }` for `ice-candidate`
- Use in-memory room map for free-tier simplicity.

---

### Issue 3
**Title:** [Phase 3] Integrate react-native-webrtc handshake and Android permissions  
**Labels:** enhancement, frontend, webrtc  
**Description:**  
> Connect the Expo React Native client to signaling, request media permissions, configure STUN/TURN, and complete peer connection handshake for Android calls.

**Tasks:**
- [ ] Configure Android permissions for camera/microphone.
- [ ] Acquire local media via `mediaDevices.getUserMedia`.
- [ ] Create and manage `RTCPeerConnection` with Google STUN + Metered.ca TURN fallback.
- [ ] Wire signaling events to create/set local+remote descriptions and add ICE candidates.

**Acceptance Criteria:**
- Users can grant permissions and see local preview stream.
- Two devices in same room establish connection and receive remote stream.
- Connection still negotiates in restrictive network scenarios using TURN credentials.

**Technical Notes:**
- ICE config example:
  - `iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'turn:global.relay.metered.ca:80', username: '...', credential: '...' }]`
- Ensure tracks from local stream are added before creating offer.

---

### Issue 4
**Title:** [Phase 4] Build warm/cozy call UI with local/remote video and media toggles  
**Labels:** enhancement, frontend, ux  
**Description:**  
> Implement the in-call interface with local and remote video rendering plus Mute/Unmute and Video On/Off controls, with a warm, cozy, illustrated visual style.

**Tasks:**
- [ ] Render remote stream as primary view and local stream as picture-in-picture.
- [ ] Add Mute/Unmute toggle by enabling/disabling local audio track.
- [ ] Add Video On/Off toggle by enabling/disabling local video track.
- [ ] Apply cozy color palette/illustrative assets consistent with performance limits.

**Acceptance Criteria:**
- Local and remote streams both render during active call.
- Toggling mute updates outgoing audio immediately without ending the call.
- Toggling video disables outgoing camera track and can be re-enabled.
- UI visually reflects control state and maintains usability on mobile screens.

**Technical Notes:**
- Toggle examples:
  - `stream.getAudioTracks()[0].enabled = false`
  - `stream.getVideoTracks()[0].enabled = false`
- Use `RTCView` for stream rendering in React Native.

---

### Issue 5
**Title:** [Phase 5] Configure EAS Android builds and deploy signaling backend to Render  
**Labels:** enhancement, infrastructure, devops, backend  
**Description:**  
> Enable cloud-only delivery by configuring Expo EAS Android builds and automated deployment for the signaling backend on Render with CI checks in GitHub Actions.

**Tasks:**
- [ ] Add `eas.json` profiles for development/preview/production APK builds.
- [ ] Configure Render service for Node signaling server and required env vars.
- [ ] Add GitHub Actions workflow for backend lint/test/build and deploy trigger.
- [ ] Document release flow from PR merge to EAS APK artifact + backend availability.

**Acceptance Criteria:**
- `eas build -p android --profile preview` runs successfully in cloud and produces APK.
- Render service deploys from configured branch and `/health` responds 200.
- GitHub Actions workflow passes on PR and shows clear deployment/build logs.

**Technical Notes:**
- Commands:
  - `npm i -g eas-cli`
  - `eas login`
  - `eas build -p android --profile preview`
- Keep secrets in GitHub/Render secret stores; never commit TURN credentials.
