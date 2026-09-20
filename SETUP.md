# Beginner Setup Guide

This guide takes you from an empty repository to a running WinGo WhatsApp signal bot.

## 1. What you are deploying

There are three pieces:

1. **Dashboard** — the browser interface hosted on Vercel.
2. **Backend** — a Render Web Service that stores configuration and exposes the API.
3. **Worker** — a Render Background Worker that keeps the WhatsApp connection alive, fetches WinGo results, predicts, and sends messages.

The Worker also owns the persistent WhatsApp session. Render does not share one filesystem disk between separate services, so the Worker disk holds `auth_info_baileys/` and Postgres holds the information both services need to share.

## 2. Create the repository

Upload the complete `wingo-bot` directory to a GitHub or GitLab repository.

Do not upload any real `.env` files or an existing `auth_info_baileys/` directory.

## 3. Deploy Render

Open Render and create a Blueprint from your repository.

The included `render.yaml` defines:

- `wingo-backend` Web Service.
- `wingo-worker` Background Worker.
- `wingo-db` PostgreSQL database.
- A persistent disk for the Worker mounted at `/var/data`.

Render persistent disks may require a paid service plan depending on the current Render product/plan available to your account. The bot itself uses no paid API.

### Backend environment values

Render will prompt for the values marked `sync: false`:

```text
FRONTEND_URL=https://your-dashboard.vercel.app
ADMIN_PASSWORD=<strong private password>
JWT_SECRET=<long random secret>
```

The remaining settings are already present in `render.yaml`.

### Worker environment values

The Worker receives its `DATABASE_URL` from the same Postgres database. Its WhatsApp auth directory is:

```text
/var/data/auth_info_baileys
```

## 4. Deploy the Vercel dashboard

Import the same repository into Vercel, set the root directory to `dashboard`, and add:

```text
VITE_API_BASE_URL=https://YOUR-BACKEND.onrender.com
```

Use the exact backend origin without a trailing slash.

## 5. Open the dashboard

Open your Vercel URL. Enter the same `ADMIN_PASSWORD` that is configured on Render.

The setup wizard has four steps: **Phone → Pairing → Channel → Start**.

## 6. WhatsApp phone-number pairing

Enter the phone number that will own the bot's WhatsApp account.

Use international digits only.

Example for Pakistan:

```text
923001234567
```

Do not include `+`, spaces, or a leading local `0`.

Click **Generate pairing code**.

The backend creates a pairing request in Postgres. The Worker sees the request, calls Baileys `requestPairingCode(phone)`, stores the result for the dashboard, and keeps the socket ready for the phone-linking flow.

### Entering the pairing code on Android

Open WhatsApp on the target phone.

Go to:

```text
WhatsApp → ⋮ → Linked devices → Link a device → Link with phone number
```

Enter the code shown by the dashboard.

### Entering the pairing code on iPhone

Open WhatsApp on the target phone.

Go to:

```text
WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number
```

Enter the dashboard code.

The dashboard does not use a QR scanner.

## 7. Confirm the Worker is connected

After successful linking, the Worker log should report that the WhatsApp connection is open and the runtime record will show `connected=true`.

The WhatsApp session is stored under:

```text
/var/data/auth_info_baileys
```

A Worker restart should reuse these credentials instead of requiring a fresh QR code.

If WhatsApp logs the session out, the Worker detects the logout and rebuilds the auth directory so a new pairing code can be requested.

## 8. Get the WhatsApp Channel / Newsletter ID

The bot sends messages to a WhatsApp Channel represented by a Newsletter JID. The dashboard expects this format:

```text
120363123456789@newsletter
```

You need the numeric JID of a channel where the linked WhatsApp account has permission to post.

Ways to obtain it include:

- Use a Baileys-based tool or diagnostic script that exposes newsletter metadata/JIDs for the linked account.
- Ask the person who manages the existing automation for the exact Newsletter JID.
- Inspect the JID returned by your own Baileys diagnostic/logging workflow when you open or query that newsletter.

Do not remove the `@newsletter` suffix.

The dashboard validates the basic JID shape before saving it.

## 9. Save the channel

Paste the JID into the setup wizard and click **Save channel**.

Example:

```text
120363123456789@newsletter
```

## 10. Start the bot

Click **Start bot**.

The Worker will:

1. fetch the WinGo history endpoint;
2. use the latest 30 results where available;
3. calculate size and color predictions;
4. calculate a confidence score;
5. send only predictions above the configured threshold;
6. wait for the predicted period to appear in the history;
7. compare the result to the signal;
8. send WIN or LOSS;
9. store the signal and outcome.

The default minimum confidence is 65%.

## 11. Local JSON fallback

For a local, single-service test without Postgres, leave `DATABASE_URL` empty and use:

```text
backend/ .env
bot-worker/ .env
```

Both services must point to the same JSON file if you want them to share state locally. In production, use Postgres because separate Render services cannot share a disk filesystem.

## 12. Troubleshooting

### Pairing code times out

Check the Worker logs. The most common causes are:

- Worker is stopped.
- Worker cannot reach WhatsApp.
- Worker and Backend are using different `DATABASE_URL` values.
- A previous pairing session is still active.
- The Render instance is restarting.

### Dashboard says offline

Check the Worker log for `WhatsApp connection opened`. Then refresh the dashboard.

### Channel messages are not appearing

Confirm:

- the channel ID ends with `@newsletter`;
- the linked account can post in that channel;
- `botActive` is true;
- Worker logs do not show `Failed to send channel message`.

### No signals are being sent

A valid connection and channel are not enough. The predictor intentionally skips a signal when the combined confidence does not exceed the configured threshold.

The default is 65%. You can increase this in Settings; increasing it makes the filter more selective.

### WinGo API errors

The Worker retries the history request with exponential backoff. Check the Worker logs for the final error after the configured number of retries.

### Session disappeared after a deployment

Make sure the Worker has its persistent disk mounted at `/var/data` and `AUTH_DIR=/var/data/auth_info_baileys`. A source-code deployment must not replace or delete that disk.

### Database connection errors

Check `DATABASE_URL`, database availability, and SSL settings. The code appends `sslmode=require` when it is not already present.

## 13. Security checklist

Use a unique `ADMIN_PASSWORD` and a long random `JWT_SECRET`.

Keep `.env` files private.

Do not commit `auth_info_baileys/`.

Keep the Vercel dashboard on HTTPS and set `FRONTEND_URL` to that exact origin.

## 14. Test checklist

Before sharing the bot with users, verify:

- dashboard login works;
- phone pairing succeeds;
- Worker reconnects after a restart;
- channel ID is accepted;
- Start/Pause changes `botActive`;
- a high-confidence signal appears in the channel;
- the next period settles as WIN or LOSS;
- signal history updates in the dashboard.


### Render PostgreSQL SSL

The backend and worker explicitly use PostgreSQL TLS with `rejectUnauthorized: false` because Render PostgreSQL can present a certificate chain that is not available as a local CA in the runtime container. Keep `DATABASE_URL` as the Render-provided connection string; do not append `sslmode=verify-full`.
