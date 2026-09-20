# WinGo WhatsApp Signal Bot

A three-tier WinGo 1M signal system with a React dashboard, Express coordination API, and Baileys background worker. It fetches public WinGo history, analyzes the latest 30 results, applies three complementary heuristics, sends signals to a WhatsApp Channel/Newsletter, then settles each signal as WIN or LOSS when the predicted period appears in the result feed.

## Architecture

```text
                   +------------------------------+
                   |        Vercel Dashboard       |
                   | React + Vite + Tailwind      |
                   +--------------+---------------+
                                  |
                                  | HTTPS JSON API
                                  v
                   +------------------------------+
                   |      Render Web Service       |
                   | Express + Auth + Rate Limit   |
                   +--------------+---------------+
                                  |
                                  | shared state
                                  v
                   +------------------------------+
                   |       Render Postgres         |
                   | settings / pairing / signals  |
                   +--------------+---------------+
                                  ^
                                  |
                   +--------------+---------------+
                   |     Render Background Worker  |
                   | Baileys + WinGo API + model   |
                   | persistent /var/data session  |
                   +---------------+--------------+
                                   |
                                   | HTTPS
                   +---------------+--------------+
                   | WinGo History JSON API        |
                   +-------------------------------+
                                   |
                                   v
                         WhatsApp Channel
                         / Newsletter JID
```

**Important Render storage detail:** a Render persistent disk is attached to one service; it is not a shared filesystem between the Web Service and Background Worker. The Worker therefore owns `auth_info_baileys/` on its own `/var/data` disk, while Postgres is the cross-service coordination store. Persistent Render disks may require a paid service plan depending on your current Render account; this is a hosting requirement rather than a paid API dependency. The JSON database fallback is intended for local/single-process usage.

## Features

- WhatsApp pairing-code linking with Baileys; no QR workflow in the dashboard.
- WinGo history fetch with timeout, retry, and payload validation.
- 3-gram pattern detection across the last 30 draws.
- Trend reversal when four or more consecutive outcomes match.
- Weighted moving average with greater weight on recent observations.
- Confidence score from 0–100%, with a configurable minimum threshold that defaults to 65%.
- Signal, WIN, and LOSS messages sent to a WhatsApp Channel/Newsletter.
- PostgreSQL storage with JSON file fallback.
- Dashboard authentication, rate limiting, reconnect action, signal history, and live status polling.
- Session persistence on the Worker disk at `/var/data/auth_info_baileys`.

## Local setup

### 1. Install Node.js

Use Node.js 20 or newer.

### 2. Create the environment files

```bash
cd wingo-bot
cp backend/.env.example backend/.env
cp bot-worker/.env.example bot-worker/.env
```

For local single-process development, omit `DATABASE_URL` in both services so the JSON fallback is used. If you want the actual Web + Worker coordination locally, point both services at the same PostgreSQL database.

Set `ADMIN_PASSWORD` and `JWT_SECRET` in `backend/.env`.

### 3. Install dependencies

```bash
cd backend && npm install
cd ../bot-worker && npm install
cd ../dashboard && npm install
```

### 4. Start the backend

```bash
cd backend
npm start
```

Backend health check: `http://localhost:10000/health`

### 5. Start the Worker

```bash
cd bot-worker
npm start
```

The Worker creates `auth_info_baileys/` under `AUTH_DIR` and handles the WhatsApp pairing code.

### 6. Start the dashboard

```bash
cd dashboard
npm run dev
```

Create `dashboard/.env.local` with:

```env
VITE_API_BASE_URL=http://localhost:10000
```

Open the Vite URL, sign in with `ADMIN_PASSWORD`, then run the four-step setup wizard.

## WinGo rules used by the bot

Size:

- `0–4` = `SMALL`
- `5–9` = `BIG`

Color:

- `0` = `RED` + Violet
- `5` = `GREEN` + Violet
- other even values = `RED`
- other odd values = `GREEN`

The bot normalizes 0 to RED and 5 to GREEN for the two-field signal format.

## Production deployment

### Render

1. Push this repository to GitHub/GitLab.
2. In Render, create a Blueprint from the repository using `render.yaml`.
3. Confirm that the two services are created: `wingo-backend` and `wingo-worker`, plus the configured PostgreSQL database.
4. Set `FRONTEND_URL` to your Vercel origin, for example `https://your-dashboard.vercel.app`.
5. Set strong random values for `ADMIN_PASSWORD` and `JWT_SECRET`.
6. Deploy both services.
7. Check `https://YOUR-BACKEND.onrender.com/health`.
8. Wait for the Worker logs to show the Baileys socket is running.

### Vercel

1. Import the repository into Vercel.
2. Set the project root to `dashboard`.
3. Build command: `npm run build`.
4. Output directory: `dist`.
5. Add `VITE_API_BASE_URL=https://YOUR-BACKEND.onrender.com`.
6. Deploy.

`vercel.json` rewrites routes back to `index.html` for the SPA.

## Hosting constraint

The requested combination of a persistent Render disk and a zero-cost Render service is not something this blueprint can guarantee across all current Render plans. This project keeps the Worker auth session on `/var/data` as requested; use a Render plan that supports persistent disks for that Worker. The API and bot logic themselves do not depend on paid third-party APIs.

## Operational notes

- The Worker must be running while a pairing code is requested because the Worker owns the Baileys socket that calls `requestPairingCode(phone)`.
- Do not commit `auth_info_baileys/`, `.env`, or database files.
- The dashboard does not expose a QR scanner. Pairing is done with WhatsApp's phone-number linking flow.
- Signals are not guaranteed to predict future lottery outcomes. The algorithm is a heuristic pattern analyzer, not a source of certainty.
