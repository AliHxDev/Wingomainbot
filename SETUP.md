# SETUP — Beginner Guide

This guide deploys the **free-oriented single-service version**. You only need:

- GitHub — source repository
- Render Web Service — backend + WhatsApp bot together
- Render PostgreSQL — persistent application data and WhatsApp credentials
- Vercel — React dashboard

There is **no Background Worker** in this version.

## 1. Upload the project to GitHub

Upload the complete contents of this project to your repository. Do not upload `.env` files, `node_modules`, or WhatsApp session files.

The important folders are:

```text
backend/      Render Web Service
 dashboard/   Vercel
```

## 2. Create Render PostgreSQL

Render → New → PostgreSQL.

For the low-cost/free configuration shown by Render:

- Compute: Free, when available on your account
- Storage: leave the minimum value
- Storage autoscaling: Disabled
- High availability: Disabled

After creation, open **Connect** and keep the **Internal Database URL** private.

## 3. Create the Render Web Service

Render → New → Web Service → select your GitHub repository.

Use:

```text
Name: wingo-backend
Root Directory: backend
Runtime: Node
Build Command: npm install
Start Command: npm start
```

Choose the free instance if available on your account.

## 4. Backend environment variables

Add these in Render → Environment:

```text
NODE_ENV=production
PORT=10000
DATABASE_URL=<Render PostgreSQL Internal Database URL>
FRONTEND_URL=*
ADMIN_PASSWORD=<your strong admin password>
JWT_SECRET=<your long random secret>
AUTH_REQUIRED=true
PAIRING_WAIT_MS=25000
SIGNAL_LOOP_MS=60000
PAIRING_POLL_MS=1000
CHANNEL_SEND_RETRIES=3
RECONNECT_COOLDOWN_MS=5000
WINGO_API_URL=https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json
WINGO_HTTP_TIMEOUT_MS=12000
WINGO_HTTP_RETRIES=3
BAILEYS_AUTH_FILE=/var/data/baileys-auth.json
BAILEYS_LOG_LEVEL=silent
LOG_LEVEL=info
TIME_ZONE=UTC
```

`FRONTEND_URL=*` is only temporary. After Vercel deployment, replace it with the exact Vercel origin, for example:

```text
FRONTEND_URL=https://wingo-bot.vercel.app
```

Do not add `CORS_ORIGIN`; this project uses `FRONTEND_URL`.

## 5. Deploy and verify the backend

After deployment, open:

```text
https://YOUR-BACKEND.onrender.com/health
```

A healthy response looks like:

```json
{
  "ok": true,
  "service": "wingo-backend",
  "connected": false
}
```

`connected: false` before WhatsApp pairing is normal.

## 6. Vercel dashboard

Vercel → Add New Project → select the same GitHub repository.

Set:

```text
Root Directory: dashboard
Framework: Vite
Build Command: npm run build
Output Directory: dist
```

Add this environment variable:

```text
VITE_API_BASE_URL=https://YOUR-BACKEND.onrender.com
```

Deploy.

## 7. Lock CORS to Vercel

Copy your Vercel URL and change Render:

```text
FRONTEND_URL=https://YOUR-DASHBOARD.vercel.app
```

Then redeploy/restart the Render Web Service.

## 8. Dashboard login

Open the Vercel URL. Use the `ADMIN_PASSWORD` you configured on Render.

## 9. WhatsApp pairing walkthrough

The setup wizard asks for the WhatsApp phone number in international digits.

Pakistan example:

```text
923001234567
```

Do not enter `+` or spaces.

The dashboard calls:

```text
POST /api/generate-code
```

The integrated Baileys service generates an 8-character pairing code.

### Android

WhatsApp → ⋮ → Linked devices → Link a device → Link with phone number → enter the code.

### iPhone

WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number → enter the code.

No QR code is used by this project.

## 10. WhatsApp credentials persistence

The application stores Baileys credentials and encryption keys in PostgreSQL. This is intentional because the free Render Web Service does not provide the persistent disk assumed by the original two-service design.

A normal application restart can therefore reload the WhatsApp authentication state from Postgres.

If the WhatsApp account is explicitly logged out, the stored credentials are cleared and a new pairing is required.

## 11. WhatsApp Channel / Newsletter ID

The dashboard expects a channel/newsletter JID in this format:

```text
120363123456789@newsletter
```

Use the channel ID exposed by the WhatsApp/Baileys environment you control. Do not guess an ID; it must be the actual newsletter JID.

Paste it into Setup → Channel.

## 12. Start the bot

After WhatsApp shows connected and the channel is saved:

1. Open Dashboard.
2. Confirm WhatsApp says Connected.
3. Confirm the channel ID is shown.
4. Press **Start bot**.

The integrated bot then fetches WinGo history approximately every 60 seconds.

## 13. Prediction logic

The predictor uses the latest 30 results and combines:

1. 3-gram pattern detection.
2. Reversal detection after four or more consecutive same-size/same-color results.
3. Weighted moving average with greater weight on recent observations.
4. A combined confidence score.

Signals are sent only when confidence is above the configured threshold. Dashboard settings allow 65–95%.

## 14. Signal settlement

The bot predicts the next issue after the latest known issue.

When the next issue appears in the WinGo history feed, the bot compares:

```text
predicted BIG/SMALL + predicted RED/GREEN
```

against the actual result and sends a WIN or LOSS message.

The result is also saved in PostgreSQL for dashboard statistics.

## 15. Troubleshooting

### Backend exits with `self-signed certificate`

Make sure the code is the current version. PostgreSQL is configured with:

```js
ssl: { rejectUnauthorized: false }
```

Do not append a guessed SSL mode to `DATABASE_URL`.

### Dashboard says network error

Check:

```text
VITE_API_BASE_URL=https://YOUR-BACKEND.onrender.com
```

and make sure `FRONTEND_URL` on Render matches the exact Vercel origin.

### Login fails

Confirm `ADMIN_PASSWORD` exists on Render and that you are using exactly that password.

### Pairing code times out

Check Render logs for:

```text
WhatsApp pairing code generated
```

If the service is sleeping, opening the backend health endpoint or dashboard can wake it. Retry after the service is running.

### WhatsApp disconnects

The bot automatically attempts to reconnect. If the account was logged out, pair it again.

### WinGo API errors

The bot retries the request three times with backoff. The configured source is:

```text
https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json
```

If that external endpoint is unavailable, no new signal can be generated until history becomes available.

### No signal appears

Check all of these:

- WhatsApp is connected.
- A valid `@newsletter` channel ID is saved.
- Bot is started.
- At least 10 results are available.
- Predictor confidence is above the configured threshold.
- There is no unsettled signal already waiting for its result.

## 16. Render free-plan limitation

A free Render Web Service can spin down after inactivity. This means the bot is not guaranteed to run continuously 24/7 on a free instance. PostgreSQL persistence prevents loss of application data and WhatsApp credentials, but it cannot keep a sleeping web service executing.

For true unattended 24/7 signals, use an always-on hosting plan.

## 17. Production checklist

- [ ] Strong `ADMIN_PASSWORD` configured.
- [ ] Strong `JWT_SECRET` configured.
- [ ] PostgreSQL connected.
- [ ] Backend `/health` returns OK.
- [ ] Vercel dashboard can log in.
- [ ] `FRONTEND_URL` equals the Vercel origin.
- [ ] WhatsApp pairing completed.
- [ ] WhatsApp status is Connected.
- [ ] Valid `@newsletter` channel ID saved.
- [ ] Bot started.
- [ ] Render logs show the integrated bot running.
- [ ] First WinGo history request succeeds.

This system provides automated pattern analysis only. It does not guarantee lottery outcomes. Play responsibly.
