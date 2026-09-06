# WeTalk — Azure Setup Guide

Complete step-by-step instructions for wiring the one Azure service WeTalk uses:
**Azure Notification Hubs**, the preferred push transport.

It is **entirely optional**. With none of the environment variables in this
guide set, the server behaves exactly as it did before: pushes fall back to
direct FCM/APNs.

> **Chat persistence is no longer an Azure concern.** Message history used to
> live in Azure Cosmos DB for MongoDB; it now lives in the `messages` table of
> the same Postgres database as everything else. See
> [`SETUP.md`](SETUP.md#message-store). Any `MONGODB_*` variables still set are
> ignored.

---

## Table of Contents

1. [Overview](#overview)
2. [Part 1 — Azure Notification Hubs](#part-1--azure-notification-hubs)
   - [Locate the namespace and hub](#11-locate-the-namespace-and-hub)
   - [Configure the Apple (APNS) credential](#12-configure-the-apple-apns-credential)
   - [Configure the Google (FCM v1) credential](#13-configure-the-google-fcm-v1-credential)
   - [Retrieve the connection string](#14-retrieve-the-connection-string)
   - [Configure the server](#15-configure-the-server)
   - [Free tier limits](#16-free-tier-limits)
   - [Troubleshooting](#17-troubleshooting)
3. [Verifying the setup](#verifying-the-setup)

---

## Overview

| Component | Azure resource | Resource group | Env vars |
|-----------|---------------|----------------|----------|
| Push notifications (calls + messages) | Notification Hubs namespace `apns-kiyon`, hub `storeman` | `sql` | `AZURE_NOTIFICATION_HUB_CONNECTION_STRING`, `AZURE_NOTIFICATION_HUB_NAME`, `AZURE_NOTIFICATION_HUB_API_VERSION` |

The signaling server talks to Notification Hubs over its **REST API**, signing
requests with a SAS token it mints from the connection string. There is **no
Azure SDK dependency** — only Node's built-in `crypto` and `https`.

> **Notification Hubs does not replace your Firebase/Apple credentials — it
> proxies them.** You still need the APNs `.p8` key and the Firebase
> service-account JSON, only now you upload them *to the hub* instead of (or in
> addition to) configuring them on the server. See
> [`FIREBASE_SETUP.md`](./FIREBASE_SETUP.md) for obtaining those credentials.

---

## Part 1 — Azure Notification Hubs

### 1.1 Locate the namespace and hub

1. Sign in to the [Azure portal](https://portal.azure.com).
2. In the top search bar type **Notification Hubs** and select
   **Notification Hub Namespaces**.
3. Open the namespace **`apns-kiyon`** (resource group **`sql`**).
4. In the left menu choose **Notification Hubs** → open the hub **`storeman`**.

Everything below happens inside the **hub** (`storeman`), not the namespace —
credentials and access policies exist at both levels and it is easy to configure
the wrong one.

### 1.2 Configure the Apple (APNS) credential

Only needed if you ship an iOS build.

1. In the hub blade, under **Settings**, click **Apple (APNS)**.
2. Set **Authentication Mode** to **Token** (the `.p8` key — it does not expire,
   unlike a `.p12` certificate).
3. Fill in:
   - **Token** — paste the *entire* contents of your `AuthKey_XXXXXXXXXX.p8` file,
     including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----`
     lines. You can also use **Upload** to select the file.
   - **Key ID** — the 10-character id shown next to the key in the Apple Developer
     portal (**Certificates, Identifiers & Profiles → Keys**), and embedded in the
     filename `AuthKey_<KeyID>.p8`.
   - **Team ID** — the 10-character Team ID from the Apple Developer portal
     (**Membership** page, "Team ID").
   - **Bundle ID** — your app's bundle identifier, `com.wetalk`. It must
     match the `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project exactly.
   - **Application Mode** — **Sandbox** for debug/TestFlight-from-Xcode builds,
     **Production** for App Store / TestFlight distribution builds.
4. Click **Save**.

> **Sandbox vs Production is the single most common iOS push failure.** A token
> minted by a development build is *only* valid against the Sandbox gateway and
> vice versa. If pushes silently vanish after switching build types, flip this
> setting.

### 1.3 Configure the Google (FCM v1) credential

1. In the hub blade, under **Settings**, click **Google (FCM v1)**.
   (Ignore the deprecated "Google (GCM)" legacy-server-key blade if present.)
2. **Private Key** — upload the Firebase **service-account JSON** file. This is
   the same file described in
   [`FIREBASE_SETUP.md` §4.1](./FIREBASE_SETUP.md#41-generate-a-service-account-key):
   Firebase console → **Project settings → Service accounts → Generate new
   private key**.
3. **Project ID** — the Firebase project id (e.g. `wetalk-12345`). It is the
   `project_id` field inside that same JSON file.
4. Click **Save**.

### 1.4 Retrieve the connection string

1. In the hub blade, under **Settings**, click **Access Policies**.
2. You will see two default policies:
   - `DefaultListenSharedAccessSignature` — client/registration use only.
   - `DefaultFullSharedAccessSignature` — **this is the one the server needs**
     (it grants `Listen, Manage, Send`).
3. Copy the **Connection string** for `DefaultFullSharedAccessSignature`. It looks
   like:

   ```
   Endpoint=sb://apns-kiyon.servicebus.windows.net/;SharedAccessKeyName=DefaultFullSharedAccessSignature;SharedAccessKey=AbCdEf...=
   ```

> ⚠️ **This string is a credential with full send + manage rights on the hub.**
> Never commit it, never ship it in the mobile app, and never paste it into an
> issue or PR.

### 1.5 Configure the server

Set these on the signaling server (systemd unit, container env, `.env`, …):

```bash
AZURE_NOTIFICATION_HUB_CONNECTION_STRING='Endpoint=sb://apns-kiyon.servicebus.windows.net/;SharedAccessKeyName=DefaultFullSharedAccessSignature;SharedAccessKey=...'
AZURE_NOTIFICATION_HUB_NAME='storeman'
# Optional — defaults to 2015-04 (the latest documented data-plane api-version
# for the /messages/?direct operation)
# AZURE_NOTIFICATION_HUB_API_VERSION='2015-04'
```

For CI/CD, add the connection string as a **GitHub Actions secret**:

1. Repository → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `AZURE_NOTIFICATION_HUB_CONNECTION_STRING`. Value: the string from §1.4.
3. Reference it in the deploy workflow as
   `${{ secrets.AZURE_NOTIFICATION_HUB_CONNECTION_STRING }}` and inject it into
   the server's environment. Do **not** echo it in a build step — Actions masks
   known secret values, but constructed/derived strings can still leak.

Once both required variables are present, `server/src/push.ts` tries Notification
Hubs **first** for every push, whatever the device's own provider is, and falls
back to direct FCM/APNs if the hub send fails. If either variable is missing the
loader logs a one-time notice and the direct path is used — nothing breaks.

The server uses Notification Hubs' **direct send** API
(`POST /{hub}/messages/?direct&api-version=…` with a
`ServiceBusNotification-DeviceHandle` header), so it targets the exact device
token already stored by `POST /devices/register`. **You do not need to migrate
devices to hub registrations or tags.**

The hub is told which native format to translate the data-only body into via
`ServiceBusNotification-Format`: `apple` for iOS devices, **`FcmV1`** for
Android/FCM devices. Google retired the FCM legacy HTTP protocol in June 2024,
and Notification Hubs' legacy `gcm` format sends to it — a hub configured with a
Google (FCM v1) credential (§1.3) will reject a `gcm`-format send with a `400`
whose body reads `The notification has no target applications. The
notification format is gcm.` (see §1.7). The server always sends `FcmV1` with
the native FCM v1 `{"message": {"android": {"data": …, "priority": "HIGH"}}}`
envelope, so it matches the hub's FCM v1 credential and stays data-only.

### 1.6 Free tier limits

The **Free** tier of Notification Hubs allows:

- **1,000,000 pushes / month**
- **500 active devices** per namespace
- No SLA, no scheduled/telemetry features

That is comfortably enough for development and a small user base. The Basic tier
raises this to 10M pushes and 200k devices.

### 1.7 Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `401 Unauthorized` | The SAS token is invalid or expired, or you used the *Listen* policy instead of *Full* | Re-copy `DefaultFullSharedAccessSignature` from **Access Policies**. Check the server clock — SAS expiry is absolute time, so heavy clock skew invalidates the token. |
| `404 Not Found` | `AZURE_NOTIFICATION_HUB_NAME` doesn't match a hub in the namespace, or the connection string points at a different namespace | Confirm the hub name (`storeman`) and that the `Endpoint=sb://…` host matches the namespace (`apns-kiyon`). |
| `400 Bad Request` with `Device handle is invalid` | The stored `pushToken` is stale (app reinstalled, token rotated, or an APNs token being sent to the FCM format) | Have the app re-register (`POST /devices/register`); prune tokens that fail repeatedly. |
| `400` with `The Token obtained from the Token Provider is wrong` | Namespace/hostname mismatch between the SAS scope and the request URI | Re-copy the connection string; don't hand-edit the `Endpoint`. |
| `400` with `The notification has no target applications. The notification format is gcm.` | The hub only has an FCM v1 (Google) credential (§1.3), but the server sent the retired legacy `gcm` format | Update the server (see `server/src/push.ts`) to send `ServiceBusNotification-Format: FcmV1` with the native FCM v1 `message` envelope — this is the format the current server code sends; if you see this error you are running an older build. |
| Push accepted (`201`) but nothing arrives on the device | Platform credential not configured in the hub, or Sandbox/Production mismatch | Re-check §1.2 / §1.3. Use the hub's **Test Send** blade to isolate hub-vs-server. |
| Android receives a push but no incoming-call screen | A `notification` block was added to the payload | Payloads must stay **data-only** — a `notification` block makes Android's system tray handle the message and skips `setBackgroundMessageHandler`. |

The portal's **Test Send** blade (hub → **Test Send**) is the fastest way to
prove the hub credentials work independently of the server.

---

## Verifying the setup

Start the server with the new variables and watch the startup logs — the
Notification Hubs "not configured" notice should be **absent**.

### Health check

```bash
curl -s http://localhost:4173/health | jq
```

### End-to-end chat + persistence

```bash
BASE=http://localhost:4173

# 1. Two sessions
ALICE=$(curl -s -X POST $BASE/session -H 'content-type: application/json' \
  -d '{"userId":"alice","deviceId":"alice-phone"}' | jq -r .sessionId)
BOB=$(curl -s -X POST $BASE/session -H 'content-type: application/json' \
  -d '{"userId":"bob","deviceId":"bob-phone"}' | jq -r .sessionId)

# 2. Register Bob's device so offline pushes have somewhere to go
curl -s -X POST $BASE/devices/register -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$BOB\",\"provider\":\"fcm\",\"pushToken\":\"<real-device-token>\"}"

# 3. Send a message over the socket (message.send), then read the history back
curl -s -H "Authorization: Bearer $ALICE" "$BASE/messages?peerId=bob&limit=10" | jq
```

If `DATABASE_URL` is configured, restart the server and re-run the last command
— the history must still be there. If it disappears, the memory store is in use;
see [`SETUP.md`](SETUP.md#message-store).

### Push delivery

With a real device token registered and the recipient's socket disconnected,
sending a message (or placing a call) should produce a server log line such as:

```
[push] Delivered message.received messageId=… via fcm (notification_hub) to device=bob-phone
```

A fallback looks like:

```
[push] Notification Hub delivery failed (reason=device_handle_invalid); falling back to direct fcm
```

To exercise the hub in isolation, use the portal's **Test Send** blade (hub →
**Test Send**), choosing platform **Apple** or **Android** and pasting a
data-only payload.

---

## See also

- [`FIREBASE_SETUP.md`](./FIREBASE_SETUP.md) — obtaining the FCM and APNs
  credentials that both Notification Hubs and the direct fallback path need.
- [`server/README.md`](../server/README.md) — the full environment-variable table,
  the push provider chain, and the `message.*` socket contract.
