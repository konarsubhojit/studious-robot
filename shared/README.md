# `@wetalk/shared` — signaling & API contracts

Single source of truth for everything that crosses the wire between
`mobile/` and `server/`:

| Module | Contents |
| --- | --- |
| `shared/schema.ts` | Tiny zod-style schema/validation helper (`safeParse`) |
| `shared/signaling/events.ts` | Every Socket.IO event name (`CLIENT_EVENTS`, `SERVER_EVENTS`, `TRANSPORT_EVENTS`) |
| `shared/signaling/schemas.ts` | Payload schema per event + `parseEventPayload()` |
| `shared/api/routes.ts` | REST paths (`API_ROUTES`) and response schemas |
| `shared/identity.ts` | `resolveDisplayName(userId, displayName)`: trimmed display name, falling back to the unchanged user ID |

## Why no `zod`?

The two apps are installed independently (`npm ci` in `mobile/` and in
`server/`, see `.github/workflows/`), so a package in `shared/` cannot resolve
a third-party dependency from either app's `node_modules`. Keeping this
package dependency-free means both the Node server (`require`) and the React
Native bundle (Metro, via `watchFolders`) consume it as-is. `schema.ts`
therefore implements the small subset of the `zod` API these contracts need —
`safeParse`, object/string/number/boolean/literal/array/record/union
combinators and `.optional()` / `.nullable()` — with the same result shape
(`{ success, data }` / `{ success, error }`), so swapping in `zod` later is a
mechanical change.

Schemas are the source of truth for the types too: each one carries a JSDoc
typedef, so editors (and `tsc --checkJs`) see the same payload shapes on both
sides of the wire.

## Signaling contract v2

Call, RTC, message, and conversation payloads use protocol version `2`.
Client-to-server requests require `version: 2`; server-to-client payloads may
omit the version as advisory metadata, but reject a present mismatch. The server
rejects requests from older clients with `unsupported_version` instead of
interpreting them using the new targeting rules.

The four chat requests select exactly one destination: `message.send` and
`message.typing` use `recipientId` for a direct chat or `conversationId` for a
group; `message.delete` and `message.react` use `peerId` or `conversationId`.
Providing both or neither is invalid. Group lifecycle requests are
`conversation.create` (`name`, `inviteeIds`), `conversation.update`
(`conversationId`, optional `name`), and `conversation.leave`
(`conversationId`). The server broadcasts `conversation.updated` with a
server-authoritative conversation snapshot and `updatedBy`.

Call and RTC events remain peer-to-peer; group calls are not part of this
contract. These schemas freeze the wire shapes only; group event handlers and
client support are separate follow-up work.

## Usage

Server (CommonJS):

```js
const { CLIENT_EVENTS, parseEventPayload } = require('../../../shared');

socket.on(CLIENT_EVENTS.CALL_INITIATE, (payload, ack) => {
  const result = parseEventPayload(CLIENT_EVENTS.CALL_INITIATE, payload);
  if (!result.success) return; // rejected + logged, never crashes the handler
});
```

Mobile (ESM, through the Babel/Metro CommonJS interop):

```js
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../../shared';
```

Metro reaches this folder because `mobile/metro.config.js` adds the repository
root to `watchFolders`.
