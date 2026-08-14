# WeTalk — Azure Setup Guide

Complete step-by-step instructions for wiring the two Azure services WeTalk uses:
**Azure Notification Hubs** (the preferred push transport) and **Azure Cosmos DB
for MongoDB** (persistent storage for text chat).

Both are **entirely optional**. With none of the environment variables in this
guide set, the server behaves exactly as it did before: pushes fall back to
direct FCM/APNs, and chat messages are kept in an in-process memory store.

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
3. [Part 2 — Azure Cosmos DB for MongoDB](#part-2--azure-cosmos-db-for-mongodb)
   - [Locate the account](#21-locate-the-account)
   - [Copy the connection string](#22-copy-the-connection-string)
   - [Create the database and collection](#23-create-the-database-and-collection)
   - [Configure the server](#24-configure-the-server)
   - [Free tier limits](#25-free-tier-limits)
   - [Troubleshooting](#26-troubleshooting)
4. [Verifying the setup](#verifying-the-setup)

---

## Overview

| Component | Azure resource | Resource group | Env vars |
|-----------|---------------|----------------|----------|
| Push notifications (calls + messages) | Notification Hubs namespace `apns-kiyon`, hub `storeman` | `sql` | `AZURE_NOTIFICATION_HUB_CONNECTION_STRING`, `AZURE_NOTIFICATION_HUB_NAME`, `AZURE_NOTIFICATION_HUB_API_VERSION` |
| Text-chat persistence | Cosmos DB account `doctor-pps` (Mongo API) | `sql` | `MONGODB_URI`, `MONGODB_DB_NAME`, `MONGODB_MESSAGES_COLLECTION` |

The signaling server talks to Notification Hubs over its **REST API**, signing
requests with a SAS token it mints from the connection string. There is **no
Azure SDK dependency** — only Node's built-in `crypto` and `https`. Cosmos DB is
reached with the standard `mongodb` driver.

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
   - **Bundle ID** — your app's bundle identifier, e.g. `com.wetalk.app`. It must
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
# Optional — defaults to 2015-01
# AZURE_NOTIFICATION_HUB_API_VERSION='2015-01'
```

For CI/CD, add the connection string as a **GitHub Actions secret**:

1. Repository → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `AZURE_NOTIFICATION_HUB_CONNECTION_STRING`. Value: the string from §1.4.
3. Reference it in the deploy workflow as
   `${{ secrets.AZURE_NOTIFICATION_HUB_CONNECTION_STRING }}` and inject it into
   the server's environment. Do **not** echo it in a build step — Actions masks
   known secret values, but constructed/derived strings can still leak.

Once both required variables are present, `server/src/push.js` tries Notification
Hubs **first** for every push, whatever the device's own provider is, and falls
back to direct FCM/APNs if the hub send fails. If either variable is missing the
loader logs a one-time notice and the direct path is used — nothing breaks.

The server uses Notification Hubs' **direct send** API
(`POST /{hub}/messages/?direct&api-version=…` with a
`ServiceBusNotification-DeviceHandle` header), so it targets the exact device
token already stored by `POST /devices/register`. **You do not need to migrate
devices to hub registrations or tags.**

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
| Push accepted (`201`) but nothing arrives on the device | Platform credential not configured in the hub, or Sandbox/Production mismatch | Re-check §1.2 / §1.3. Use the hub's **Test Send** blade to isolate hub-vs-server. |
| Android receives a push but no incoming-call screen | A `notification` block was added to the payload | Payloads must stay **data-only** — a `notification` block makes Android's system tray handle the message and skips `setBackgroundMessageHandler`. |

The portal's **Test Send** blade (hub → **Test Send**) is the fastest way to
prove the hub credentials work independently of the server.

---

## Part 2 — Azure Cosmos DB for MongoDB

### 2.1 Locate the account

1. In the [Azure portal](https://portal.azure.com) search for **Azure Cosmos DB**.
2. Open the account **`doctor-pps`** (resource group **`sql`**).
3. Confirm the API. The overview blade shows the API next to the account name —
   this resource is the **Azure Cosmos DB for MongoDB** API.

> Cosmos DB accounts are **single-API**: an account created for NoSQL/Core,
> Cassandra, or Gremlin cannot serve MongoDB traffic. If `doctor-pps` is not a
> Mongo-API account you must create a new account and choose
> **Azure Cosmos DB for MongoDB** during creation.

### 2.2 Copy the connection string

1. In the account's left menu choose **Settings → Connection strings**.
2. Copy the **PRIMARY CONNECTION STRING**. It looks like:

   ```
   mongodb://doctor-pps:<key>@doctor-pps.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@doctor-pps@
   ```

3. **Verify that `retrywrites=false` is present.**

> ⚠️ **`retrywrites=false` is mandatory.** The Cosmos DB Mongo API does not
> support retryable writes, and modern MongoDB drivers enable them by default. If
> the parameter is missing, every insert fails with
> `This MongoDB deployment does not support retryable writes` (or a bare
> `MongoServerError: Retryable writes are not supported`). Azure's copyable
> string normally includes it — if you build the URI by hand, append
> `&retrywrites=false`.

### 2.3 Create the database and collection

You can let the driver create both on first write, but creating them explicitly
lets you set the throughput and shard key deliberately.

1. In the account's left menu choose **Data Explorer**.
2. Click **New Collection**.
3. Fill in:
   - **Database id** — `wetalk` (choose *Create new*).
   - **Share throughput across collections** — recommended on the free tier, so
     the 1000 RU/s allowance is pooled.
   - **Collection id** — `messages`.
   - **Shard key** — `conversationId`.
   - **Provision dedicated throughput for this collection** — leave unchecked if
     you enabled shared database throughput above.
4. Click **OK**.

> **Why `conversationId` as the shard key?** All reads are "give me the history
> of one conversation", so partitioning by `conversationId` keeps every query
> single-partition (cheap in RU) and spreads writes evenly across conversations.
> Sharding by `senderId` would hot-spot on chatty users; sharding by `messageId`
> would turn every history read into a cross-partition fan-out.

On first connect the server creates two indexes idempotently:

- compound `{ conversationId: 1, createdAt: -1 }` — backs the newest-first
  history query;
- unique `{ messageId: 1 }` — makes message persistence idempotent.

If index creation fails (e.g. insufficient permissions) the server logs a warning
and keeps running.

### 2.4 Configure the server

```bash
MONGODB_URI='mongodb://doctor-pps:<key>@doctor-pps.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@doctor-pps@'
# Optional — these are the defaults
# MONGODB_DB_NAME='wetalk'
# MONGODB_MESSAGES_COLLECTION='messages'
```

Add `MONGODB_URI` as a **GitHub Actions secret** exactly as in §1.5 — it embeds
the account's primary key and grants full read/write access.

When `MONGODB_URI` is unset the server uses `createMemoryMessageStore()`. Chat
still works end-to-end; history simply does not survive a restart. This is the
configuration the test suite runs in.

### 2.5 Free tier limits

The Cosmos DB **free tier** (one account per Azure subscription) provides:

- **1000 RU/s** of provisioned throughput, and
- **25 GB** of storage,

free forever. Exceeding the provisioned RU/s returns HTTP 429 / `TooManyRequests`;
the `mongodb` driver surfaces this as a `MongoServerError` with code `16500`.
Chat traffic is tiny per message, so 1000 RU/s covers a small deployment
comfortably — but a cross-partition or unindexed query can burn the entire budget
in one request, which is why the shard key and indexes above matter.

### 2.6 Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `MongoServerError: Retryable writes are not supported` | `retrywrites=false` missing from the URI | Append `&retrywrites=false` (see §2.2). |
| `MongoServerError` code `16500` / `TooManyRequests` | RU/s budget exceeded | Raise throughput, or check for a query missing the `conversationId` filter. |
| `MongoServerSelectionError` after ~30s | Firewall/VNet rules, or `ssl=true` stripped from the URI | In **Networking**, allow the server's public IP (or "Allow access from Azure portal + all networks" for a quick test). Keep `ssl=true`. |
| Server logs `[messages] index creation failed` | The account key lacks DDL rights, or the collection is sharded differently | Non-fatal. Create the indexes manually in Data Explorer. |
| History is empty after a restart | `MONGODB_URI` is not actually reaching the process | Check the startup log for the store selection line; an unset URI silently uses the memory store by design. |

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
curl -s "$BASE/messages?peerId=bob&limit=10&sessionId=$ALICE" | jq
```

If `MONGODB_URI` is configured, restart the server and re-run the last command —
the history must still be there. If it disappears, the memory store is in use.

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
- [`server/README.md`](./server/README.md) — the full environment-variable table,
  the push provider chain, and the `message.*` socket contract.
