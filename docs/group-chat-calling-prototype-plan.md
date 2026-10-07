# Group chat and calling prototype completion plan

Audited 2026-10-07 against the shipped group messaging and group-call decisions
and their referenced implementation and test coverage. This plan coordinates
prototype completion; it does not replace either decision record.

## Outcome

Deliver a repeatable, live prototype in which authenticated users can create a
private group, exchange messages across devices, and start or join a real
audio/video call with the current group members. Existing direct chats and
one-to-one calls must continue to work.

The repository already contains the bounded messaging implementation and
four-person mesh call implementation. The remaining work is to configure and
exercise those paths together, resolve integration defects found in that
exercise, and record device-level evidence. Passing unit and mocked WebRTC
tests alone is not prototype acceptance.

## Session status and handoff (2026-10-07)

**State: focused automated checks are green; live prototype acceptance is not
started.**

- [x] Rechecked the group messaging and call decision records and their
  implementation/test references.
- [x] Refreshed the focused automated baseline: server group/call suites
  reported 102 passed, 0 failed, and 3 skipped; the six focused mobile suites
  reported 89 passed. These results do not establish live service or device
  behavior.
- [ ] Prepare the isolated live environment in §1. This session had no
  configured test deployment, accounts, or physical devices available;
  `adb` and `xcrun` were unavailable. Consequently `GROUP_TRANSPORT=live`,
  persistent-service integration, and physical-device/TURN behavior remain
  unverified.
- [ ] Run and record the live messaging journey in §2, then the group-call
  matrix in §3. Record failures and evidence as they occur; do not mark
  untested cases passed.
- [ ] Fix any observed integration defects and rerun the applicable checks in
  §4. Complete the acceptance report in §5 only after the stated evidence is
  collected.

**Resume here:** follow [the setup guide](./SETUP.md) to provision an isolated
PostgreSQL-backed test deployment and configure signaling, attachment, push,
and ICE/TURN services as available. Build live-transport clients for test
accounts, record revisions and device/network details, verify direct-chat and
direct-call smoke paths, then continue with §2. Keep this section current with
dated outcomes and blockers after each verification session.

## Fixed scope and constraints

- Group messages remain server-readable, with the membership, history,
  authorization, and attachment rules in
  [the group messaging MVP decision](./group-messaging-mvp.md). Production
  messaging E2EE is not part of this plan.
- Groups have at most 16 active members. Group calls use full mesh and admit at
  most four participants total, including the local user. A call uses the
  accepted members snapshotted at start; later group joins do not join that
  call.
- Five- or six-person calls require a separately designed and operated SFU.
  Recording, public/discoverable groups, join links, and a production launch
  are not prototype requirements.
- A live group call requires the app's live group transport, working signaling,
  media permissions, and usable ICE/TURN configuration. TURN is relay for
  individual peer connections, not a group media server.

## Current implementation inventory

| Area | Already present | Prototype gap to close |
| --- | --- | --- |
| Group messaging | Server group routes and stores, durable membership and message data, group history/search, lifecycle and block authorization, fan-out, account-erasure handling, mobile group screens, and live transport in `mobile/src/hooks/useMessaging.ts`. | The mobile transport defaults to local mock mode; run and verify a live cross-device flow using `GROUP_TRANSPORT=live`. Prove integration with the actual deployed-like database, signaling, attachment storage, and push configuration rather than inferring readiness from isolated tests. |
| Group calls | Four-person mesh signaling and media, admission limits, rejoin/leave lifecycle, call history, participant UI, mobile media handling, and mock-backed automated coverage. The architecture and known limits are in [the group-call topology decision](./group-call-topology.md). | Physical-device bidirectional AV and native lifecycle have not been established. Exercise supported iOS and Android devices, real network paths (including TURN), and direct-call regression. |
| Automated validation | The decision records report server, mobile, typecheck, lint, migration, and Android bundle/build results as of 2026-10-06; focused group tests are listed in the two decision records. | Those results are recorded evidence, not a substitute for the live prototype run below. Re-run the relevant automated checks after any implementation changes found during integration. |

## Work plan

### 1. Make a reproducible live test environment

1. Follow the existing [setup guide](./SETUP.md); use an isolated test
   deployment with PostgreSQL migrations applied and the supported signaling,
   attachment, and ICE/TURN services configured. Do not use production user
   data or commit credentials.
2. Build/install the same mobile revision for at least three authenticated test
   accounts on two supported physical devices for messaging. Reserve four
   supported physical devices for the four-participant call gate. Configure the
   mobile build with `GROUP_TRANSPORT=live`; verify the running build actually
   selects live mode rather than the local group mock.
3. Record app/server revisions, device models and OS versions, transport
   configuration names (never secret values), and the test network used.
4. Confirm the existing direct-message and direct-call smoke paths still work
   before exercising group paths.

**Exit:** a second engineer can start the isolated server and live mobile
clients from the documented setup, authenticate test accounts, and distinguish
live group state from local mock state.

### 2. Verify the real group messaging journey

Using separate accounts and devices, run this sequence against the live
environment:

1. Create a group; invite another account; verify the invitee must accept
   before group content or attachments become visible.
2. Exchange messages in both directions. Verify delivery, acknowledgement,
   read/unread state, conversation-list updates, and history after app restart
   and reconnect. Retry a send across a transient disconnect and confirm there
   is only one accepted message.
3. Exercise the supported attachment flow in both directions. A nonmember,
   pending invitee, departed member, or member whose join time predates the
   joined after the referenced content was created must not download content
   they are not entitled to.
4. Search permitted history; verify a later invitee cannot see pre-join
   messages. Check mute and push behavior on a physical device when push
   services are configured.
5. Remove or leave a member while their client is online and while it is
   offline. Verify membership reconciliation, revocation of history/search/
   attachment access and future delivery, while remaining members continue to
   use the group.
6. Verify the defined blocked-sender behavior and that direct conversations
   remain unchanged.

**Exit:** every step has an observed result; server logs/database state confirm
durable group membership and messages; there are no duplicate sends, direct
conversation regressions, or post-revocation reads/delivery. Record any
unsupported optional service (such as push) explicitly instead of marking that
check passed.

### 3. Verify live group calls and limits

1. From a live group, start audio and video calls with two, three, then four
   participants on physical devices. Confirm every intended participant is
   invited and can join, and a group newcomer is not added to an already-live
   room.
2. Verify bidirectional audio/video, microphone mute, camera off/on and
   switching, speaker/earpiece/Bluetooth routing where supported, and screen
   sharing where supported. Verify permissions denial and retry, background/
   foreground transitions, and sustained-call recovery.
3. Have a participant leave and rejoin while the others remain connected;
   verify only that participant's peer connections are recreated and existing
   media continues. Also exercise decline, missed/ended history, network loss,
   reconnect, and app restart.
4. Verify an oversized group is refused before call insertion or ringing, an
   attempted fifth admission is rejected, and the UI explains the four-person
   ceiling. Verify a blocked or otherwise ineligible member prevents a
   partially invited call as specified by the topology decision.
5. Exercise at least one direct call before and after group calls, including
   media controls and teardown, to catch shared call-state or native audio
   ownership regressions.
6. Test a TURN-relayed path, preferably an all-TURN call, and capture connection
   success/failure and relay usage. Do not infer TURN coverage from configured
   credentials or a successful direct ICE path.

**Exit:** two-, three-, and four-person calls pass the applicable device and
network checks with no stale peer, microphone, camera, or audio-session
ownership after teardown. Record device/network-specific failures and do not
claim unsupported paths passed.

### 4. Close integration defects and rerun automated gates

Fix only defects observed in the flows above. Add focused regression tests to
the existing server/mobile suites for each fixed behavior, preserving current
direct-message and direct-call tests. Re-run the relevant existing checks:

- Server group lifecycle, messaging, fan-out, call lifecycle/history tests,
  plus server typecheck, lint, and `db:check` when server/schema code changed.
- Mobile group-screen, transport/call-adapter, group media, and relevant
  direct-chat/call tests, plus mobile typecheck and lint when mobile code
  changed.
- Existing Android build/bundle validation for native or release configuration
  changes; use an iOS build-capable environment for native iOS changes.

Use the repository's existing test commands from each package. Do not treat
mocked native media tests as physical-device acceptance.

For the focused checks listed above, run from the respective package directory:

```sh
# server/
node --experimental-test-module-mocks --test \
  test/groups.test.ts \
  test/group-conversations.test.ts \
  test/group-message-fanout.test.ts \
  test/group-call-lifecycle.test.ts \
  test/call-history.test.ts \
  test/calls.test.ts
npm run typecheck
npm run lint
npm run db:check

# mobile/
npx jest --ci --forceExit --runInBand \
  __tests__/components/GroupScreens.test.tsx \
  __tests__/messaging/groupTransportAdapter.test.ts \
  __tests__/messaging/groupCallAdapter.test.ts \
  __tests__/hooks/useGroupCallMedia.test.tsx \
  __tests__/hooks/useCallHistory.test.tsx \
  __tests__/components/CallsScreen.test.tsx
npm run typecheck
npm run lint
```

Run the database check when database or migration code changes; run lint and
typecheck when code changes. Add the relevant existing direct-chat, direct-call,
and history test files to the focused command when their paths are changed.

**Exit:** all targeted automated checks pass; every integration fix has a
regression test; direct chat and one-to-one calls remain green.

### 5. Record prototype acceptance and known limits

Publish a concise run report linked from this plan containing the revision,
environment, test accounts by non-sensitive alias, device/OS matrix, scenarios
passed/failed/not run, and defects filed or fixed. Never include credentials,
personal message contents, or sensitive call data.

The prototype is complete only when:

- A fresh environment can run the live group messaging journey in §2.
- Live 2–4 participant group calls pass §3 on the tested supported device
  matrix, with actual network/TURN results recorded.
- The checks in §4 pass after any fixes.
- The run report clearly lists any untested OS/device, push, network, or
  peripheral behavior and preserves the four-person mesh limit.

This is a prototype sign-off, not production readiness. Broader rollout still
requires separately reviewed capacity, abuse/reporting, monitoring, privacy,
support, and release decisions; a larger call group requires an SFU decision
and implementation.

## Existing implementation and test references

- Messaging: [`groups.routes.ts`](../server/src/routes/groups.routes.ts),
  [`conversationStore`](../server/src/conversationStore/),
  [`useMessaging.ts`](../mobile/src/hooks/useMessaging.ts),
  [`GroupConversationScreen.tsx`](../mobile/src/components/GroupConversationScreen.tsx),
  [`groups.test.ts`](../server/test/groups.test.ts),
  [`group-conversations.test.ts`](../server/test/group-conversations.test.ts),
  [`group-message-fanout.test.ts`](../server/test/group-message-fanout.test.ts),
  and [`GroupScreens.test.tsx`](../mobile/__tests__/components/GroupScreens.test.tsx).
- Calling: [`group-call-topology.md`](./group-call-topology.md),
  [`group-call-lifecycle.test.ts`](../server/test/group-call-lifecycle.test.ts),
  [`useGroupCallMedia.ts`](../mobile/src/hooks/useGroupCallMedia.ts),
  [`useGroupCallMedia.test.tsx`](../mobile/__tests__/hooks/useGroupCallMedia.test.tsx),
  and [`GroupCallPreview.tsx`](../mobile/src/components/GroupCallPreview.tsx).
