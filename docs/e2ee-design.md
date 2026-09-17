# End-to-end encrypted messaging and attachments — design and go/no-go

Decision record for issue **P3: Define an end-to-end encrypted messaging and
attachment design**. This document defines the threat model, the architecture a
credible implementation would need, what each subsystem would have to give up,
the candidate protocol libraries, and the **explicit go/no-go decision**. It is
a decision, not an implementation plan: nothing here authorises shipping a
cryptosystem.

> **Status: no-go for production E2EE at this time. Conditional go for a
> bounded, feature-flagged prototype** once the prerequisites in
> [§11](#11-decision) are met. See [§12](#12-what-we-must-not-claim-today) for
> the claims that must not be made in the meantime.

---

## 1. Where the product is today

Today the service is **transport-encrypted and server-readable**. That is a
deliberate consequence of the current design, not an oversight:

| Capability | Where | What the server sees |
| --- | --- | --- |
| Message bodies | `server/db/schema.ts` (`messages.body`, `messages.attachment`, `messages.reactions`) | Plaintext body, attachment metadata, reactions, reply graph |
| Full-history search | `idx_messages_body_trgm` and the participant-scoped `*_body_trgm` GIN indexes; `GET /messages/search` in `server/src/routes/messages.routes.ts` | Plaintext bodies, in an index built over `lower(body)` |
| Conversation list | `conversations` projection in `server/db/schema.ts` | Participants, last-message pointer, unread counters |
| Attachments | `server/src/attachments.ts`, `shared/messages.ts` | Plaintext bytes in R2, plus MIME type, size and file name |
| Push previews | `server/src/push/envelopes.ts`, `describeMessagePreview` in `shared/messages.ts` | Server renders a plaintext preview into the notification |
| Account export | `server/src/routes/accountExport.routes.ts` | Server assembles the archive from plaintext rows |
| Backups | `ops/wetalk-backup.sh` (`pg_dump -Fc`) | Full plaintext database dump |
| Offline replay | `mobile/src/messaging/sendPipeline.ts` durable outbox | Client-side only; identity (`messageId`) is stable across retries |

Call **media** is already encrypted hop-by-hop by WebRTC (SRTP/DTLS), and TURN
relays do not hold media keys for a direct peer connection. That is *not* E2EE
messaging and must never be described as such.

Local mobile storage is sandboxed SQLite, explicitly documented in
`mobile/README.md` as **not** application-level or end-to-end encryption.

---

## 2. Threat model

### 2.1 In scope — what E2EE would protect against

1. **Passive compromise of the message store or its backups.** A stolen
   `pg_dump`, a snapshot of the Postgres host, or read access to the R2 bucket
   yields ciphertext instead of conversations and attachments.
2. **A curious or compromised operator.** Anyone with production database or
   object-storage access — including a future managed-hosting provider —
   cannot read message content.
3. **Compelled disclosure of content.** A lawful request can only produce what
   the service holds; under E2EE that is metadata, not bodies.
4. **Attachment URL leakage.** Today a leaked public R2 URL leaks the file;
   encrypted blobs leak only ciphertext.

### 2.2 Out of scope — what E2EE would *not* protect against

1. **A malicious or compromised client build.** The client holds the keys; a
   backdoored app, a compromised OS, or a jailbroken/rooted handset defeats
   E2EE entirely.
2. **A malicious server performing an active key-substitution attack**, unless
   users actually verify each other (§4) or a transparency mechanism is
   deployed. This is the single biggest gap between "E2EE on the wire" and
   "E2EE users can rely on".
3. **Metadata analysis** (§3). Encrypting bodies does not hide who talks to
   whom, when, or how much.
4. **Endpoint capture** — screenshots, OS-level backups, accessibility
   services, a recipient forwarding the plaintext.
5. **Account takeover of the identity provider.** Firebase auth compromise
   (`server/src/firebaseAuth.ts`) lets an attacker enrol a new device; E2EE
   limits it to *future* messages only if key-change warnings are shown and
   heeded (§5).
6. **Availability and denial of service.** Unchanged by E2EE.

### 2.3 Assumed adversaries

| Adversary | Capability assumed | Mitigated by E2EE? |
| --- | --- | --- |
| Network observer | Sees TLS-protected traffic, sizes, timing | Already mitigated by TLS; timing/size remain |
| Object-storage reader | Reads R2 objects | Yes, with encrypted attachments |
| Database reader (dump, backup, replica) | Reads all rows | Yes, for bodies and attachment metadata that we move into the ciphertext |
| Honest-but-curious server operator | Full runtime access, but does not tamper | Yes, for content |
| Actively malicious server | Substitutes identity keys, lies about device lists | **Only** with user verification or key transparency |
| Compromised endpoint | Full control of one device | No |

---

## 3. Metadata exposure — what remains visible to the service

Even with a correct implementation, the service continues to see, and must be
documented as seeing:

- **Social graph and timing** — `messages.senderId`, `messages.recipientId`,
  `messages.createdAt`, and the entire `conversations` projection.
- **Message rate and approximate size** — ciphertext length is a bounded
  function of plaintext length unless padded. Padding to buckets is cheap and
  should be part of the envelope format.
- **Delivery and read receipts** — `deliveredTo`, `readAt`.
- **Attachment existence, ciphertext size, and upload timing** — the R2 key is
  server-generated and conversation-scoped (`createAttachmentKey`), so the
  bucket layout itself reveals conversation activity. MIME type and file name
  *can* be moved into the ciphertext; ciphertext size cannot.
- **Device inventory** — the `devices` table, platform, and registration
  recency.
- **Call history** — `calls`, `call_events`; entirely unaffected by message
  E2EE.
- **Presence and account directory** — presence lookups and
  `server/src/routes/directory.routes.ts`.

Reducing this metadata (sealed sender, per-conversation opaque identifiers,
decoupling attachment keys from `conversationId`) is a **separate, much larger**
programme and is explicitly **not** in scope here. Any user-facing claim must
say plainly that metadata remains visible.

---

## 4. Device identity and verification

- **Identity key per device, not per account.** Each install generates a
  long-term identity key pair in platform-backed storage (iOS Keychain with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, Android Keystore). The
  private key never leaves the device and is never backed up. `device_id` in
  `server/db/schema.ts` is already the per-install identity and is the natural
  join key for a `device_keys` table.
- **The server is a key directory, not a trust root.** It stores public
  identity keys, signed pre-keys and one-time pre-keys, and serves pre-key
  bundles. It is trusted for availability and ordering only.
- **Verification is required for the strong claim.** A safety-number /
  QR-code comparison per contact, plus a **persistent, non-dismissible
  key-change warning** when a peer's identity key changes. Without this, an
  active server can transparently substitute keys and E2EE provides no
  guarantee against the operator.
- **Key transparency is out of scope** for the first iteration; manual
  verification plus key-change warnings is the documented mitigation, and its
  weakness (users do not verify) must be stated in the user-facing copy.

---

## 5. Enrollment, rotation, revocation and lost devices

| Event | Behaviour |
| --- | --- |
| **New device enrolled** | Publishes its identity key and pre-key bundle. Existing devices of the same account and all peers see a key-change notice. The new device starts with **no history** (see §8). |
| **Pre-key rotation** | Signed pre-key rotated on a fixed schedule; one-time pre-keys replenished when the server reports the pool is low. Server must never hand out the same one-time pre-key twice. |
| **Identity key rotation** | Only on reinstall or explicit reset; treated as a new device, with the same key-change notice. |
| **Device removal / revocation** | Removing a device revokes its session keys prospectively and must also revoke its push registration and session bearer. Revocation is **not retroactive**: a removed device keeps whatever plaintext it already decrypted. This is the shared boundary with the independent device-revocation work, which should proceed on its own schedule. |
| **Lost device** | User removes it from another enrolled device; peers are notified of the change. If it was the *only* device, the account keeps no recoverable message keys — history is lost unless an encrypted-backup mechanism exists (§6). |
| **Account deletion** | `account_deletions` cascade already removes rows and blobs; key material is additionally deleted, making residual ciphertext permanently undecryptable. |

**Compromise recovery** is prospective only: rotating identity keys stops
future reads; it cannot claw back past plaintext. Double-Ratchet forward
secrecy and post-compromise security make this a bounded window rather than a
total loss, which is a primary reason to adopt a ratcheting protocol rather
than plain per-message public-key encryption.

---

## 6. Recovery, backup and multi-device history

This is where an E2EE messenger is won or lost in practice, and it must be
decided **before** any implementation:

- **Option A — no history transfer (default).** A new device sees only messages
  sent after enrollment. Simplest and safest. Users lose history on device loss.
- **Option B — device-to-device transfer.** Existing device encrypts its local
  history to the new device over an authenticated channel. No server trust, but
  requires both devices present.
- **Option C — client-encrypted server backup.** The client uploads a blob
  encrypted under a key derived from a user-chosen high-entropy recovery code
  (or an HSM-backed key-escrow service). Convenient, but introduces a new
  cryptosystem, a new key-escrow threat model, and a password-guessing surface.

**Decision for a first iteration: Option A, with Option B as the first
follow-up.** Option C requires its own design and its own security review and
must not be bundled in.

`ops/wetalk-backup.sh` continues to back up Postgres, but a restored dump would
contain only ciphertext for E2EE conversations. **Database backups therefore
stop being a user-recovery mechanism for message content** and become a
service-continuity mechanism only. The operational documentation must say so.

---

## 7. Encrypted attachments

Consistent with the existing presign flow in `server/src/attachments.ts`:

1. Client generates a fresh symmetric key per attachment, encrypts the bytes
   with an AEAD, and computes a digest of the ciphertext.
2. Client requests a presigned `PUT` for the **ciphertext**. The server signs
   `content-length` and `content-type` today; for encrypted blobs `content-type`
   becomes a single opaque value (e.g. `application/octet-stream`) and the size
   cap applies to the ciphertext, so `MAX_ATTACHMENT_BYTES` in
   `shared/messages.ts` must account for AEAD overhead.
3. The attachment key, the real MIME type, the file name, the duration/waveform
   for voice notes, and the ciphertext digest travel **inside the encrypted
   message payload**, never in `messages.attachment`.
4. The recipient fetches the ciphertext, verifies the digest, then decrypts.

Consequences that must be accepted explicitly:

- **Server-side MIME allowlisting stops being meaningful** for encrypted
  attachments: the server cannot see the real type. The allowlist moves to the
  receiving client, which must refuse to render or open anything outside it
  (`mobile/src/attachmentOpen.ts` is the enforcement point). This is a genuine
  reduction in server-side defence in depth and is the strongest argument for
  keeping the size cap and rate limits strict.
- **Thumbnails and waveforms must be generated client-side** and carried in the
  encrypted payload.
- Blob lifecycle, deletion on account erasure (`deleteAttachmentObject`) and
  the "managed URL only" check (`isManagedAttachmentUrl`) are unaffected —
  they operate on keys and URLs, not content.
- This composes with, and does not block, the independent
  **private attachment access** work: short-lived authenticated reads are
  valuable with or without E2EE.

---

## 8. Subsystem impact — the things that must be given up or rebuilt

| Subsystem | Impact under E2EE | Resolution |
| --- | --- | --- |
| **Server-side search** (`GET /messages/search`, the trigram indexes) | **Impossible.** The server cannot index ciphertext. | Search moves entirely to the client over locally held history. Consequence: search only covers what the device has. The `idx_messages_body_trgm` family becomes dead weight for E2EE rows. Encrypted-search schemes (searchable encryption, blind indexes) leak patterns and are **rejected** — they are custom cryptography by another name. |
| **Push previews** (`server/src/push/envelopes.ts`) | Server cannot render `describeMessagePreview`. | Push becomes strictly data-only ("New message"), with the client decrypting and rendering the real notification locally. The message-receipt stages in `server/src/routes/devices.routes.ts` (`notification_shown` / `notification_failed`) already exist precisely because message pushes are data-only, so this path is partly in place. iOS requires a Notification Service Extension; **this does not exist today and is a hard prerequisite.** |
| **Account export** (`accountExport.routes.ts`) | Server cannot assemble readable message content. | Export splits: the server exports metadata and ciphertext; the **client** produces the human-readable message archive. Call history and device records export unchanged. |
| **Backups** (`ops/wetalk-backup.sh`) | Restores return ciphertext. | Documented as service continuity, not content recovery (§6). |
| **Abuse reporting** | No server-visible content to adjudicate. Note that the product has **no report flow today** — only blocking (`blocks` table). | If reporting is ever built, it must be **client-attested**: the reporting client submits the decrypted messages it chooses to disclose, together with enough cryptographic context to bind them to a sender. Any such scheme is its own design and its own review. |
| **Conversation projection / unread counts** | Unaffected — derived from metadata only. | No change. |
| **Offline replay** (`sendPipeline.ts`) | The outbox must store the **plaintext** locally and encrypt at send time, because the ratchet state advances per send and a pre-encrypted payload cannot be safely replayed. The stable `messageId` identity and `clientCreatedAt` ordering are preserved. | Encryption happens in the drain step, not at compose time. |
| **Legacy clients** | A client that cannot decrypt must not render garbage. | `shared/messages.ts` already defines the compatibility rule: unknown types render a neutral placeholder via `describeMessagePreview`. An `encrypted` message type inherits that behaviour on old builds, which makes a staged rollout possible. |
| **Retention sweep** (`server/src/lib/retention.ts`) | Unaffected; operates on timestamps. | No change. |

---

## 9. Migration and compatibility

1. **No rewriting of history.** Existing plaintext messages stay plaintext.
   E2EE applies to new messages in conversations where **all** participating
   devices advertise support.
2. **Per-conversation capability negotiation.** A conversation upgrades only
   when every enrolled device of both participants has published a key bundle
   and a supported protocol version. A single legacy device downgrades the
   conversation, and that downgrade must be **visible in the UI**, never
   silent.
3. **Schema shape.** New message type `encrypted`, with the ciphertext in
   `body` and only routing metadata outside it; new `device_keys` and
   `one_time_prekeys` tables. `messages` keeps its primary key and indexes, so
   ordering, paging, cursors and the conversations projection are untouched.
4. **Irreversibility.** Once a conversation is encrypted, the server can never
   reconstruct those bodies. Rollback of the *feature* is possible; rollback of
   the *data* is not. This alone justifies a flagged, staged rollout.

---

## 10. Candidate protocols and libraries

Custom cryptography is out of the question. The realistic options:

| Option | Protocol | Maintenance | Licence | Fit for React Native + Node |
| --- | --- | --- | --- | --- |
| **libsignal** (Signal) | X3DH + Double Ratchet, Sesame for multi-device | Actively maintained by Signal | AGPL-3.0 | Rust core with Java/Swift/TypeScript bindings. **The AGPL licence is the decisive constraint** and must be cleared by legal before anything else; it is not a drop-in for a proprietary client. No first-party React Native binding — a native module would have to be written and maintained for both platforms. |
| **MLS (RFC 9420)** via OpenMLS | Continuous Group Key Agreement | Actively maintained | MIT/Apache-2.0 | Standardised and permissively licensed. Designed for groups; for 1:1 it is more machinery than needed. React Native bindings would have to be built and maintained. |
| **vodozemac / Olm–Megolm** (Matrix) | Double Ratchet variant | Actively maintained by the Matrix.org Foundation | Apache-2.0 | Permissive, audited, Rust core. Mobile bindings exist but again not for React Native out of the box. |
| **libsodium** primitives directly | None — we would design the protocol | Actively maintained | ISC | **Rejected.** Sound primitives do not give a sound protocol; this is exactly the "new cryptosystem" the issue forbids. |

Common findings:

- **Every option requires a maintained native module for React Native**, on
  both iOS and Android, plus an upgrade treadmill. That ongoing cost, not the
  initial integration, is the dominant expense.
- **Licensing must be resolved first.** libsignal's AGPL-3.0 terms are a
  go/no-go input in their own right.
- A **third-party security review** of the integration (not of the library) is
  mandatory before any production claim: integration mistakes — key storage,
  identity binding, verification UX, ratchet-state persistence across the
  durable outbox — are where E2EE implementations actually fail.

---

## 11. Decision

### 11.1 Go/no-go

**No-go for production end-to-end encryption at this time.**

Rationale:

1. Four user-visible capabilities — server-side search, push previews,
   server-generated account export, and content recovery from backups — are
   load-bearing today and would have to be removed or rebuilt client-side. That
   is a product decision, not an engineering one, and it has not been made.
2. Two hard prerequisites do not exist yet: an iOS **Notification Service
   Extension** for local notification rendering, and a **maintained React
   Native binding** for any candidate library.
3. Without contact verification UX and key-change warnings, E2EE would not
   actually defend against the malicious-server case that motivates it — the
   protection would be weaker than the wording would imply.
4. The licensing position for the most mature option (libsignal, AGPL-3.0) is
   unresolved.
5. The migration is irreversible for data. Shipping it before the above are
   settled risks an unrecoverable outcome for users.

### 11.2 Conditional go — bounded prototype

A **time-boxed, feature-flagged, internal-only prototype** is approved to
retire the unknowns, subject to all of the following:

- It is **off by default**, gated behind a build flag, and never enabled for
  real users.
- It touches **no existing plaintext data** and adds no migration that
  rewrites `messages`.
- It makes **no user-facing E2EE claim** of any kind.

Prototype exit criteria — each must be answered with evidence:

1. A React Native native module for one candidate library builds and runs on
   both iOS and Android, with a measured build/size/startup impact.
2. A 1:1 encrypted exchange works end to end across two devices, including
   ratchet state surviving app restart and the durable outbox replay path in
   `mobile/src/messaging/sendPipeline.ts`.
3. An encrypted attachment round-trips through the existing presign flow with
   the ciphertext-size and opaque-content-type changes of §7.
4. A data-only push wakes an iOS Notification Service Extension that decrypts
   and renders the notification.
5. Client-side search over locally held history is demonstrated, with measured
   latency on the oldest supported device, so the search regression is
   quantified rather than assumed.
6. Licensing is cleared in writing for the chosen library.

### 11.3 Gate before any production implementation

Production work requires, in order:

1. Prototype exit criteria met and written up.
2. A product decision explicitly accepting the losses in §8.
3. Verification UX (safety numbers plus key-change warnings) designed.
4. A third-party security review of the integration.
5. A second, recorded go/no-go on this document, superseding §11.1.

### 11.4 Independent work that is not blocked

These proceed on their own schedule and are valuable regardless of the outcome:

- **Private attachment access** — replacing public R2 URLs with short-lived
  authenticated reads.
- **Device revocation** — revoking sessions, bearers and push registrations.
- **Metadata minimisation and retention tightening.**

---

## 12. What we must not claim today

- The service is **not** end-to-end encrypted. HTTPS/TLS is transport
  encryption; SRTP/DTLS in WebRTC protects call media in transit. Neither is
  E2EE messaging.
- Message bodies, attachment metadata and attachment bytes are readable by the
  service and appear in backups.
- Local device storage is sandboxed SQLite, not application-level encryption
  (`mobile/README.md`).

Any marketing, README, or in-app copy that implies otherwise is a defect.
