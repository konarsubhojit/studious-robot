# Group-call media topology — decision record

Decision record for the first group-call implementation. This chooses a bounded
initial topology and specifies how to avoid making that choice a permanent
signalling constraint.

> **Decision: ship a full mesh for groups of at most four participants, provided
> the topology-neutral group signalling contract in §6 is used.** Use an SFU for
> larger groups or when hardware/network verification shows mesh is not reliable.
> This is a product and architecture decision, not evidence that four-person
> calls have passed device testing.

## 1. Threat and constraint model

- Group calls must work on supported iOS and Android clients, including
  mid-range Android devices and restrictive NATs/mobile networks.
- Minimise new operational responsibilities until actual group usage justifies
  a media service. Group calls still need authenticated signalling, membership
  checks, rate limits and abuse controls regardless of media topology.
- WebRTC encrypts each connection with DTLS-SRTP. In mesh, media is encrypted
  between participants; a TURN relay forwards encrypted packets without
  terminating that connection. This is hop-by-hop transport security, not a
  promise that signalling cannot be manipulated.
- A topology must have a defined participant ceiling and a migration plan.
  The current call model/signalling is caller-callee, not a group protocol;
  replicating those events without redesigning their identity and routing would
  make a later SFU transition a breaking change.
- The E2EE design record is a **no-go for production messaging E2EE**, not a
  decision about call media. Nevertheless, call-media confidentiality from the
  service is a relevant future constraint (§5).

## 2. Options

| Option | Upload cost at N=4 | Server cost | New infra |
| --- | --- | --- | --- |
| Full mesh | Up to 3 copies of each client's outgoing media: (N−1)× per client | Signalling only; TURN may relay individual peer connections | None beyond the existing TURN service |
| SFU (e.g. LiveKit / mediasoup / Janus) | One copy per client | Media relay/fan-out and egress; SFU capacity and operations | A media host plus monitoring, upgrades, capacity planning and on-call; a managed SFU substitutes vendor cost/limits for host operations |

With four participants, a mesh client may upload its audio/video to three peers
and decode up to three remote publishers. An SFU client publishes once; the
SFU receives one copy per publisher and forwards selected streams to
subscribers. TURN is not an SFU: it relays a peer-to-peer connection and does
not provide group fan-out or track selection.

## 3. Decision and practical ceiling

Start with full mesh and cap a call at **four participants total, including the
local participant**. This is a conservative product ceiling, not a universal
hardware limit. Four participants mean up to three outgoing media copies and
three remote video decoders per device; uplink contention, encoder/decoder
work, battery drain and thermal throttling can reduce quality or end a call,
especially on mid-range Android phones. Lower resolution, bitrate or video
subscriptions may help but do not remove the scaling limit.

The server enforces the four-person ceiling when invitees accept, so concurrent
accepts cannot overfill a mesh. Remaining invitees receive a clear full-call
response and the group-call UI explains the limit. A participant grid may render
six entries for presentation or diagnostics, but that does not raise the
connected-mesh ceiling.

Do not raise the cap based on simulator results or signalling tests. Move to an
SFU before offering larger calls or promising reliable multi-video on mobile.
An SFU can receive a single publication per client and select/fan out tracks,
at the cost of operating or buying a media service and of the trust tradeoff in
§5.

## 4. TURN coverage and cost

The repository already supports issuing Cloudflare Realtime TURN credentials
from the signalling server (`CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN`); other credential paths include Metered.ca and
self-hosted coturn. That integration is **NAT traversal for peer connections**,
not a group media server. Its presence in code does not prove Cloudflare TURN
is enabled on the deployed environment or guarantee a capacity/usage allowance.

TURN load grows with the media that actually traverses relayed peer paths.
In a four-person mesh, each participant still negotiates up to three
peer-to-peer connections; a connection can be direct or relayed independently.
If all media is relayed, the relay forwards the duplicated per-recipient
streams. If direct ICE paths succeed, those streams do not consume TURN relay
bandwidth. Therefore the configured TURN service may relay a mesh call, but
does not make mesh traffic one-copy and cannot be treated as SFU capacity.
Measure relay usage and check the account's quotas before setting a production
call-volume target.

Cloudflare Realtime's published pricing, checked 2026-10-03, is **1,000 GB of
egress free per month, then $0.05/GB**; ingress is not charged. TURN and SFU
share that allowance and billing line item. TURN egress is data sent from the
Cloudflare relay to a TURN client (including TURN overhead), so only the
relayed portion is billed; estimate from measured relayed egress, not just
participant count. Rates and allowances can change. See the [Cloudflare Realtime
pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) and
[TURN pricing FAQ](https://developers.cloudflare.com/realtime/turn/faq/).

## 5. Interaction with E2EE

The [messaging E2EE decision](./e2ee-design.md) is a no-go for production
messaging encryption today. It does not authorize or forbid a particular call
topology. Mesh gives WebRTC DTLS-SRTP protection between each pair of
participants (subject to the existing signalling-server/fingerprint
substitution risk); TURN does not decrypt it.

An SFU terminates each participant's DTLS-SRTP connection and can access media
after decrypting it, then re-encrypts a separate connection to each subscriber.
Thus a conventional SFU makes the media service a trusted endpoint and
forecloses confidentiality of call content from that service. Application-layer
media E2EE over an SFU may be possible, but is not implemented or established
by the messaging decision; it would require a separate design for key
distribution, verification, device changes, track encryption and feature
compatibility, plus security review. Do not claim group calls are end-to-end
encrypted merely because WebRTC transport encryption is enabled.

## 6. Migration without a second protocol break

**Yes, mesh can ship first without a second client signalling-protocol break,
but only if the group-call protocol is designed for both topologies now.** The
existing 1:1 caller/callee messages are not that protocol and must not simply be
copied once per peer.

The first group protocol should model a call/room and participant identities,
and route each negotiation by a stable negotiation/endpoint identifier rather
than assuming one caller and one callee. Make topology explicit (`mesh` or
`sfu`) and allow the server to provide per-participant SFU connection
information (endpoint and short-lived credentials) without changing event
meaning. In mesh, a negotiation identifies its two participants; with an SFU,
each participant negotiates with the SFU endpoint. Keep membership and
authorization independent of the media route.

The later change is then a server-selected topology plus an ordinary
renegotiation/rejoin, not a second incompatible signalling schema. It need not
be seamless: an active mesh call may reconnect when moved to the SFU. If the
initial implementation instead hard-codes caller/callee routing or has no way
to express an SFU endpoint, switching later will require a protocol break.

## 7. What still needs hardware and operational verification

Before enabling group calls broadly:

1. Test two-, three- and four-person mesh calls on representative iOS devices
   and low-, mid- and high-range Android phones, including older supported
   mid-range devices.
2. Measure uplink/downlink, CPU, battery drain, device temperature and call
   quality over a sustained call; repeat on cellular, congested Wi-Fi and
   background/foreground transitions. Confirm whether four participants is a
   safe cap and set video defaults accordingly.
3. Test mixed direct and TURN-relayed peer paths, including a call where every
   path requires TURN. Record TURN egress, cost, connection success and failure
   behaviour, and establish deployed-account quotas and alerts.
4. If selecting an SFU, load-test four and larger groups, validate regional
   latency, failover, capacity/cost alerts, operations ownership and the
   participant verification/E2EE implications before production use.

No group-call hardware, TURN-load or SFU-capacity result is asserted by this
decision record.
