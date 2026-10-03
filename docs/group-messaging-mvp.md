# Bounded group messaging MVP — product and data decision

Decision record for issue **#411**, resolving the admission/history review in
**#537**. It defines the smallest useful private group chat and deliberately
leaves the current one-to-one path unchanged.

> **Status: resolved; implementation deferral closed.** The current
> [E2EE decision](./e2ee-design.md#11-decision) is no-go for production E2EE,
> so the group MVP is server-readable, like existing one-to-one messages. This
> decision closes the E2EE-related deferral; group implementation must follow
> the admission and history rules below. Revisiting E2EE requires a new,
> recorded production go/no-go that explicitly covers group admission, history
> visibility, and key distribution/revocation; this record must then be reviewed
> against that decision before any encrypted-group implementation.

## 1. Product boundary

The MVP is a **private study team**: a small, known set of classmates sharing
planning, notes, and attachments. It is not a community, broadcast channel,
class roster, public-link group, or a replacement for a learning-management
system.

- A group has at most **16 active members**, including its creator. This bounds
  one accepted message to 15 recipient-state writes and 15 user notification
  decisions; notification delivery is then bounded by the existing reachable-
  device selection per user. Raising the cap would increase both database
  fan-out and push amplification linearly, so larger groups need a measured
  capacity decision rather than an arbitrary cap increase.
- Membership is by direct, account-addressed invitation only. There are no
  join links, directory search, or discovery.
- Group audio and video calls are explicitly out of scope. They need a separate
  media-topology and capacity decision; a group must not be accepted as a call
  target.
- Group messages and attachments are readable by the server, as are current
  one-to-one messages and attachments. This MVP makes no E2EE claim and chooses
  no group key protocol.

## 2. Membership and authority

Every group has a stable opaque `group_id`, a creator, a name, and a monotonically
increasing `membership_version`. Its active membership is the sole authority
source; a client-provided recipient list, group name, or socket room is never
authority.

| Role | May do |
| --- | --- |
| Owner | All admin actions, promote/demote admins, transfer ownership, delete the group. |
| Admin | Invite, cancel an invitation, remove a member, and change group name. |
| Member | Read, search permitted history, send messages/attachments, react, mute, and leave. |

The MVP has owner and admin roles; members have equal ordinary messaging
permissions, but not equal authority. Only the owner or an admin may invite.
The owner cannot be removed or leave while owner. They must first transfer
ownership to an active admin; if there is no suitable admin, they may promote
one. An admin may not remove the owner or themselves. The creator starts as the
owner; invited accounts start as members. Inviting an already active member,
creating a second pending invitation for the same account, self-inviting, and
exceeding 16 active members all fail.

An invitation names exactly one account, records the issuer and
`membership_version`, and expires after 7 days. Acceptance is explicit; an
invitation grants no read, attachment, search, socket, or notification access
until it is accepted. An owner or admin may cancel it. Blocks prevent a direct
invitation when either participant has blocked the other; existing groups are
not silently reshaped by a later block.

All following operations resolve the caller's **active** member row on the
server:

| Operation | Required authorization |
| --- | --- |
| Send/retry, edit/delete, reactions | Active member; sender identity is derived from session. |
| History and message search | Active member, limited to messages visible to that member's membership interval. |
| Attachment presign | Active member; object key is scoped to `group_id`, not a peer-derived conversation ID. |
| Attachment download | Member visibility for the message that references the object, not possession of a key or a current room subscription. |
| Socket subscription and catch-up | Active member; server joins a private `group_id` room only after this check and removes it on departure. |

The same checks apply to REST, sockets, background jobs, and push fan-out. A
room name is a delivery optimization, never evidence of membership.

## 3. Lifecycle, history, and races

`group_members` is an append-only membership interval: `joined_at`,
`left_at`, `removed_at`, actor, and reason are recorded rather than overwritten.
`group_membership_events` records invites, accepts, leaves, removals, role
changes, ownership transfers, and deletion so all devices can reconcile a
durable ordered timeline.

- **Join/history decision:** accepting an unexpired invitation creates an
  interval at the commit time. A new member cannot see messages or attachments
  from before `joined_at`; no prior history is backfilled or searchable. This
  protects earlier group content from being exposed to a later invitee. It
  requires every history, search, and attachment-visibility read to enforce that
  member's `joined_at` watermark; that per-member filter is part of the schema
  contract, not an optional optimization.
- **Leave:** an active member may leave immediately. They retain the history and
  attachments already downloaded locally, subject to normal retention and
  account erasure. Server-side, they lose history, search, attachment-download,
  socket, and push access immediately; their interval remains as audit/history
  for entitled members, but cannot authorize further reads by the departed
  member. They receive no later messages or pushes.
- **Removal:** owner/admin removal closes the member's interval immediately.
  It has the same local-retention and server-access consequences as leaving, but
  is distinguishable from voluntary leave: `removed_at`, actor, reason, and a
  removal event record the action. It does not retract bytes already downloaded
  or plaintext already displayed.
- **Deletion:** only the owner may delete an empty group. Deleting a populated
  group requires first removing or having every non-owner leave, preventing one
  account from unexpectedly destroying other members' history.

Membership changes and sends serialize in one database transaction. A send
locks/checks the sender's active interval and snapshots active recipients at
commit; an acceptance locks the group capacity and invitation. Therefore a
message is either rejected because removal/leave committed first, or accepted
once and visible to the recipient set active at its commit—never partly
fan-outed. Socket events and pushes are emitted only after commit. A device that
was offline, or briefly received an event while a removal raced, must reconcile
membership before rendering/catching up; it cannot fetch post-removal content.

## 4. Read state, mute, notifications, and safety

Group state is per member, not two columns on a conversation:

- `group_member_state` has `last_read_message_id`, `last_read_at`,
  `unread_count`, and nullable `muted_until`. Mark-read advances a member's
  cursor monotonically and zeroes only that member's counter.
- Sending writes the group message once and increments unread state for each
  other active member in the same transaction. At the 16-member limit this is
  at most 15 bounded updates. A sender's own state remains read.
- A muted member still receives and can read history, but receives no message
  push or sound/badge increment until `muted_until` passes; membership/lifecycle
  events still produce a silent data sync so removal cannot be missed.
- Fan-out is per **user**, then uses the existing bounded reachable-device
  selection. It must not create one logical message per device. Failed pushes
  follow existing token-pruning/outcome handling and do not alter message
  acceptance or unread state.

Blocking is pairwise and does not remove either account or conceal shared
membership. Group messages continue to be delivered to all active members
regardless of a block; the one-to-one block predicate does not filter group
delivery, for which membership is the authority. If either member has blocked
the other, the blocker's client still receives that sender's group messages but
gets no push or preview for them; the messages still count toward group unread
state, are shown behind a local “blocked sender” disclosure, and are excluded
from the blocker's local search. Thus group messages from either side remain
visible to the other party in the shared group. Direct invitations remain
forbidden for a blocked pair. Blocking therefore is not a way to remove someone
from a shared group; owner/admin removal and audit logs are the available
moderation response.
The MVP has no user-report workflow. A user-facing report and staff
case-handling flow is a prerequisite for any future larger/public group
proposal, not silently implied by this MVP.

## 5. Data, migration, and compatibility

Do **not** overload `messages`, `conversations`, `recipient_id`, or the
peer-keyed mobile model. They stay the optimized 1:1 source of truth and
projection. A later implementation adds separate `groups`, `group_members`,
`group_invitations`, `group_membership_events`, `group_messages`, and
`group_member_state` tables, with group-specific indexes for member history and
member-scoped search. Attachment keys gain a distinct group scope and download
authorization joins the attachment's message to the caller's visibility
interval.

This is additive: no historical rewrite and no conversion of a direct
conversation. Group APIs and socket events are separately versioned and enabled
only for clients advertising group capability. Older clients continue to receive
the unchanged 1:1 conversation/list/history protocol; the server omits group
rows/events rather than sending an unknown peer or treating a group as a direct
conversation. Rollback disables creation and delivery of new group activity
without corrupting stored group data.

Account erasure closes active memberships, cancels invitations, revokes socket
subscriptions and pushes, and removes the account's member-state rows in the
same durable workflow. Shared group messages and attachments remain available
to other entitled members, so the erased sender identity is replaced with a
non-identifying deleted-account marker and any attachment object exclusively
owned by that erased account is deleted. The implementation must make this
distinction explicit in the existing account-erasure worker and export policy.

Before approval, measured acceptance criteria are:

1. Existing direct-message list/history/search queries retain their current
   query plans and pagination bounds; no group join is added to their read path.
2. Direct-message send, unread, attachment, and socket tests remain unchanged,
   with a baseline-versus-change latency/query-count comparison under the
   existing load profile.
3. Group send proves one message insert, at most 15 recipient-state updates,
   and bounded per-user device fan-out; concurrent removal/send and
   invitation/capacity races are integration-tested.
4. Authorization tests cover every operation in §2, including a removed member
   attempting history, search, download, and room re-subscription.

## 6. Implementation decision

This record closes the prior implementation deferral. Implementation may be
planned against the server-readable admission, history, block, and lifecycle
decisions above, while preserving the separate one-to-one data and read path.
If production E2EE is reconsidered, group implementation must pause for a new
recorded decision that explicitly resolves group admission, pre-join history,
and group-key distribution/revocation; this document must be reviewed against
that decision before encrypted-group work proceeds. Implementation work should
carry the acceptance criteria above.
