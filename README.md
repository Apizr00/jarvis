# 🤖 Jarvis — Personal AI Assistant for Telegram

A self-hosted personal assistant that lives in your Telegram. Talk to it naturally — set reminders, log events, save notes, and let it remember things about you.

**Stack:** Node.js · PostgreSQL · DeepSeek API · Telegram Bot API

---

## ✅ What it can do

| You say... | Jarvis does... |
|---|---|
| "Remind me to call mum at 6pm" | Creates a DB reminder, fires at exactly 6pm |
| "Add gym to calendar tomorrow 7am" | Saves an event |
| "Note: look into React Native" | Saves a note |
| "What's my day?" | Shows today's events + reminders |
| "Remember I sleep at 1am" | Stores a long-term memory fact |
| `/today` | Quick schedule overview |
| `/notes` | Last 10 notes |
| `/memory` | All stored facts about you |

---

## 📋 Requirements

- Node.js **v18+**
- PostgreSQL **v14+** (local or remote)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- A DeepSeek API key (from [platform.deepseek.com](https://platform.deepseek.com))
- Your personal Telegram user ID

---

## 🚀 Setup (Step by Step)

### Step 1 — Get your Telegram Bot Token

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Pick a name (e.g. `My Jarvis`) and username (e.g. `myjarvis_bot`)
4. Copy the token — looks like `7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### Step 2 — Get your Telegram User ID

1. Open Telegram, search for **@userinfobot**
2. Send `/start`
3. It replies with your ID — looks like `123456789`

### Step 3 — Get your DeepSeek API Key

1. Go to [platform.deepseek.com](https://platform.deepseek.com)
2. Sign up / log in
3. Go to **API Keys** → **Create new key**
4. Copy it — looks like `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### Step 4 — Set up PostgreSQL

**Option A: Local (Ubuntu/Debian VPS)**
```bash
sudo apt update && sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql

sudo -u postgres psql -c "CREATE USER jarvis WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE jarvisdb OWNER jarvis;"
```

**Option B: Use a cloud DB**
- [Neon.tech](https://neon.tech) — free PostgreSQL in the cloud
- Copy the connection string, it looks like:
  `postgresql://user:pass@ep-xxx.neon.tech/jarvisdb`

### Step 5 — Install and configure Jarvis

```bash
# Unzip the project
unzip jarvis.zip
cd jarvis

# Install dependencies
npm install

# Copy env file and fill in your values
cp .env.example .env
nano .env   # or use any editor
```

Fill in `.env`:
```env
TELEGRAM_BOT_TOKEN=7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_OWNER_ID=123456789
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DATABASE_URL=postgresql://jarvis:yourpassword@localhost:5432/jarvisdb
PORT=3000
TIMEZONE=Asia/Kuala_Lumpur
```

> ⚠️ **TIMEZONE** — use your local timezone so reminders fire at the right time.
> Full list: [en.wikipedia.org/wiki/List_of_tz_database_time_zones](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
>
> Malaysia → `Asia/Kuala_Lumpur`
> Singapore → `Asia/Singapore`
> UTC → `UTC`

### Step 6 — Create the database tables

```bash
npm run setup-db
```

You should see:
```
🔧 Setting up Jarvis database...
✅ All tables created successfully!
```

### Step 7 — Start Jarvis

```bash
npm start
```

You should see:
```
  ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
  ...
✅ Jarvis is fully operational.
🤖 Jarvis bot is online and polling...
⏰ Reminder scheduler started (every 30 seconds)
🌐 API server running on http://localhost:3000
```

Now open Telegram, find your bot, and send `/start`! 🎉

---

## 🖥️ Running on a VPS (keep it running forever)

Use **PM2** to run Jarvis as a background process that auto-restarts:

```bash
# Install PM2 globally
npm install -g pm2

# Start Jarvis with PM2
pm2 start src/index.js --name jarvis

# Save config so it restarts on reboot
pm2 save
pm2 startup

# Useful commands
pm2 status          # check if running
pm2 logs jarvis     # view live logs
pm2 restart jarvis  # restart
pm2 stop jarvis     # stop
```

---

## 🌐 REST API (optional)

The app also runs a local API for debugging:

| Endpoint | Description |
|---|---|
| `GET /health` | Check if server is running |
| `GET /today` | Today's events and reminders (JSON) |
| `GET /memory` | All stored data (JSON) |
| `POST /notes` | Add a note `{"content":"..."}` |

Example:
```bash
curl http://localhost:3000/today
curl http://localhost:3000/memory
curl -X POST http://localhost:3000/notes \
  -H "Content-Type: application/json" \
  -d '{"content":"great idea I had"}'
```

---

## 🗂️ Project Structure

```
jarvis/
├── src/
│   ├── index.js          # Entry point
│   ├── bot/
│   │   └── index.js      # Telegram bot, message handling
│   ├── llm/
│   │   └── deepseek.js   # DeepSeek API integration
│   ├── tools/
│   │   └── index.js      # Tool executor (create_reminder, add_note, etc.)
│   ├── scheduler/
│   │   └── index.js      # Cron job that fires due reminders
│   ├── api/
│   │   └── index.js      # REST API server
│   └── db/
│       └── index.js      # All database queries
├── scripts/
│   └── setup-db.js       # One-time DB table creation
├── .env.example          # Environment variable template
├── package.json
└── README.md
```

---

## 🔧 Troubleshooting

**"Missing required environment variables"**
→ Make sure `.env` exists and all 4 required values are filled in.

**"password authentication failed for user jarvis"**
→ Double-check the password in `DATABASE_URL` matches what you set in PostgreSQL.

**Bot not responding**
→ Check `TELEGRAM_OWNER_ID` — it must be your numeric user ID, not your username.
→ Run `pm2 logs jarvis` to see errors.

**Reminders not firing**
→ Check your `TIMEZONE` in `.env`. Use the exact timezone string from the tz database.
→ Times are stored in UTC internally; the timezone converts display and input.

**"Check your DeepSeek API key"**
→ Make sure your DeepSeek account has credits. New accounts get free credits.

---

## 🚀 What's next (v2 ideas)

- Voice messages via Whisper API
- Morning briefing (`/morning` command)
- Recurring reminders (daily habits)
- Web dashboard
- Multi-device sync

---

## 💰 Running costs

| Service | Cost |
|---|---|
| VPS (e.g. Hetzner CX11) | ~€4/month |
| PostgreSQL (Neon free tier) | Free |
| DeepSeek API | ~$0.001 per message (very cheap) |
| Telegram Bot API | Free |

**Total: roughly €4–5/month** for a fully personal AI assistant.
