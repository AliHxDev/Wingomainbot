# WinGo WhatsApp Signal Bot

A complete WinGo 1M signal system with a React dashboard, an Express API, PostgreSQL persistence, and an integrated Baileys WhatsApp service.

> **Free Render architecture:** the WhatsApp process now runs inside the same Render Web Service as the API. There is **no Render Background Worker** and no paid persistent disk requirement. WhatsApp credentials are stored in PostgreSQL so a normal service restart does not require a new QR or pairing session.

## Architecture

```text
                         GitHub
                           |
                 +---------+----------+
                 |                    |
              Vercel                Render
                 |                    |
        React + Vite          +-------+-------+
        Tailwind UI            |               |
                 |          Express API   Baileys Bot
                 +----------->|               |
                              +-------+-------+
                                      |
                                Render Postgres
                                      |
                         settings / signals / auth
                                      |
                              WhatsApp Channel

                         WinGo public history API
                                      |
                              predictor (30 draws)
                                      |
                              signal + settlement
```

## What the system does

1. Dashboard authenticates with an admin password.
2. Dashboard requests a WhatsApp pairing code through the backend.
3. The integrated Baileys service generates the pairing code without a QR.
4. Baileys credentials and Signal keys are persisted in PostgreSQL.
5. Every 60 seconds the bot fetches WinGo 1M history.
6. The predictor analyzes the latest 30 results using 3-gram pattern detection, trend reversal, and weighted moving averages.
7. A signal is sent only when confidence is above the configured threshold (65–95%).
8. The next result is used to settle the signal as WIN or LOSS.
9. Dashboard statistics and signal history are stored in PostgreSQL.

## Repository structure

```text
wingo-bot/
├── README.md
├── SETUP.md
├── render.yaml
├── vercel.json
├── .gitignore
├── backend/
│   ├── server.js
│   ├── bot-service.js
│   ├── auth-store.js
│   ├── predictor.js
│   ├── wingo-api.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── channel.js
│   │   └── status.js
│   ├── db/connection.js
│   ├── package.json
│   └── .env.example
└── dashboard/
    ├── index.html
    ├── vite.config.js
    ├── tailwind.config.js
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── index.css
        ├── api/client.js
        └── pages/
            ├── Setup.jsx
            ├── Dashboard.jsx
            └── Settings.jsx
```

## Local setup

### Backend

```bash
cd backend
cp .env.example .env
npm install
npm start
```

For local development without Postgres, omit `DATABASE_URL`; the backend uses a JSON fallback. For a real WhatsApp session, PostgreSQL is recommended because it persists Baileys credentials and keys.

### Dashboard

```bash
cd dashboard
npm install
npm run dev
```

Set `VITE_API_BASE_URL=http://localhost:10000` in `dashboard/.env` if the backend is not running on that address.

## Render deployment

1. Push the entire repository to GitHub.
2. Create a Render PostgreSQL database named `wingo-db`.
3. Create one **Web Service** from the repository.
4. Set root directory to `backend`.
5. Build command: `npm install`.
6. Start command: `npm start`.
7. Use the environment variables described in `SETUP.md`.
8. Do **not** create a Background Worker for this version.

The included `render.yaml` describes the single Web Service plus the PostgreSQL database.

### Free Render limitation

A free Render Web Service may spin down after inactivity. If it sleeps, the WhatsApp connection cannot actively send signals while the process is stopped. Opening the dashboard generates requests and can wake the service, but this is **not a guarantee of 24/7 unattended signal delivery on a free plan**. For continuous unattended operation, a continuously running Render plan or another always-on host is required.

The application itself has no paid API dependency.

## Vercel deployment

1. Import the same GitHub repository into Vercel.
2. Set **Root Directory** to `dashboard`.
3. Framework: Vite.
4. Build command: `npm run build`.
5. Output directory: `dist`.
6. Add:

```text
VITE_API_BASE_URL=https://YOUR-BACKEND.onrender.com
```

After deployment, copy the Vercel URL into Render's `FRONTEND_URL` environment variable and redeploy the backend.

## Security

- Never commit `.env` files.
- Use a long random `JWT_SECRET`.
- Use a strong `ADMIN_PASSWORD`.
- Keep the Render PostgreSQL connection string private.
- Keep the WhatsApp credentials in PostgreSQL private.
- CORS is restricted to `FRONTEND_URL` once configured.
- Pairing-code endpoint is rate limited.

## WinGo rules implemented

- `0–4` = SMALL
- `5–9` = BIG
- `0` = RED + VIOLET by the source game's convention; this bot records the requested two-way color as RED.
- `5` = GREEN + VIOLET by the source game's convention; this bot records the requested two-way color as GREEN.
- Other even numbers = RED.
- Other odd numbers = GREEN.

## Signal format

```text
🎯 WinGo 1M Signal
━━━━━━━━━━━━━━━━
📊 Period: {issueNumber}
🎲 Prediction: {BIG/SMALL} {emoji}
🎨 Color: {GREEN/RED}
📈 Confidence: {score}%
⏱️ Time: {HH:MM:SS}
━━━━━━━━━━━━━━━━
⚠️ Play responsibly
```

## Important

This is an automated pattern-analysis system, not a guarantee of future lottery outcomes. Lottery results can be random and past results do not establish future results. Use responsibly.
