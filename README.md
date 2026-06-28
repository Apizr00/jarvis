# 🤖 Jarvis — Personal AI Assistant for Telegram

A self-hosted personal AI assistant that lives in your Telegram. Talk to it naturally — set reminders, schedule events, save notes, and let it remember things about you. Wakes you up with a morning briefing complete with weather and a motivational quote.

**Stack:** Node.js · PostgreSQL · Redis (optional) · DeepSeek + Xiaomi MiMo · Telegram Bot API

---

## ✅ What it can do

| You say...                         | Jarvis does...                                         |
| ---------------------------------- | ------------------------------------------------------ |
| "Remind me to call mum at 6pm"     | Creates a reminder, pings you at exactly 6pm           |
| "Cancel my call mum reminder"      | Cancels the matching reminder by ID                    |
| "Move my gym reminder to 8am"      | Updates the reminder time                              |
| "Remind me to stretch every day"   | Creates a recurring daily reminder                     |
| "Add gym to calendar tomorrow 7am" | Saves an event                                         |
| "Note: look into React Native"     | Saves a note                                           |
| "What's my day?" / `/today`        | Shows today's events + reminders                       |
| "Remember I sleep at 1am"          | Stores a long-term memory fact                         |
| "What do you know about me?"       | Shows all stored facts about you                       |
| "Motivate me" / "Give me a quote"  | Fetches a motivational quote from ZenQuotes            |
| **Automatic: every morning**       | 🌅 Morning briefing — weather, quote, today's schedule |
| `/notes`                           | Last 10 notes                                          |
| `/memory`                          | All stored facts about you                             |

---

## 📋 Requirements

- Node.js **v18+**
- PostgreSQL **v14+** (local or remote)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- A DeepSeek API key (from [platform.deepseek.com](https://platform.deepseek.com))
- Your personal Telegram user ID
- _(Optional)_ Redis **v7+** — caches user facts, bot works without it
- _(Optional)_ Xiaomi MiMo API key — backup LLM fallback if DeepSeek is down
- _(Optional)_ OpenWeatherMap API key — enables weather in the morning briefing

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

# Primary LLM
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com

# Backup LLM (optional — auto-fallback if DeepSeek fails)
MIMO_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
MIMO_MODEL=mimo-v2.5-pro

# Weather (optional — enables weather in morning briefing)
# Get a free API key at https://openweathermap.org/api
WEATHER_API_KEY=your_openweathermap_api_key
WEATHER_LOCATION=Kuala Lumpur

# Database
DATABASE_URL=postgresql://jarvis:yourpassword@localhost:5432/jarvisdb

# Redis (optional — facts cache, bot works without it)
REDIS_URL=redis://localhost:6379

PORT=3000
TIMEZONE=Asia/Kuala_Lumpur

# Morning briefing time (24h format, default 8:00)
MORNING_BRIEFING_TIME=8:00
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

The app runs a local API for debugging and external integrations:

| Endpoint      | Description                                  |
| ------------- | -------------------------------------------- |
| `GET /`       | API info — name, version, available routes   |
| `GET /health` | Health check — status + uptime               |
| `GET /today`  | Today's events and reminders (JSON)          |
| `GET /memory` | All stored data — facts, events, notes, etc. |
| `POST /notes` | Add a note `{"content":"..."}`               |

Example:

```bash
curl http://localhost:3000/today
curl http://localhost:3000/memory
curl -X POST http://localhost:3000/notes \
  -H "Content-Type: application/json" \
  -d '{"content":"great idea I had"}'
```

---

## 🧠 LLM Fallback Architecture

Jarvis uses a primary + backup LLM setup for reliability:

```
User message
    │
    ▼
┌─────────────────────┐
│   LLM Router        │
│   (src/llm/index.js)│
└──────┬──────────────┘
       │
       ├── 1️⃣ DeepSeek (primary)
       │      └── fails? →
       │
       └── 2️⃣ Xiaomi MiMo (backup)
              └── fails? → throw error
```

- **Redis cache** sits in front of both providers — user facts are cached for 10 minutes, reducing DB load on every message
- If Redis is unavailable, the bot still works — just queries PostgreSQL directly
- Set `MIMO_API_KEY` in `.env` to activate the backup. Skip it and only DeepSeek is used

---

## 🗂️ Project Structure

```
jarvis/
├── src/
│   ├── index.js          # Entry point — boots everything
│   ├── bot/
│   │   └── index.js      # Telegram bot, message handling, commands
│   ├── llm/
│   │   ├── index.js      # LLM Router (DeepSeek → MiMo fallback)
│   │   ├── shared.js     # Shared system prompt builder
│   │   ├── deepseek.js   # DeepSeek API provider (primary)
│   │   └── mimo.js       # Xiaomi MiMo API provider (backup)
│   ├── tools/
│   │   ├── index.js      # Tool executor (create_reminder, add_note, etc.)
│   │   ├── quote.js      # Random motivational quote fetcher (ZenQuotes)
│   │   └── weather.js    # Current weather fetcher (OpenWeatherMap)
│   ├── scheduler/
│   │   └── index.js      # Cron jobs: reminder poller + morning briefing
│   ├── api/
│   │   └── index.js      # REST API server (Express)
│   ├── redis/
│   │   └── index.js      # Redis cache layer (optional, auto-fallback)
│   └── db/
│       └── index.js      # All PostgreSQL database queries
├── scripts/
│   └── setup-db.js       # One-time DB table creation
├── test-briefing.js      # Quick test script for morning briefing
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
→ Jarvis auto-falls back to MiMo if configured — no downtime.

**"Redis unavailable — running without cache"**
→ Not an error. Redis is optional. Bot works fine without it, just hits DB more often.
→ To enable: install Redis (`sudo apt install redis`), start it, set `REDIS_URL` in `.env`.

**"All LLM providers are unavailable"**
→ Both DeepSeek AND MiMo are down (or API keys are invalid).
→ Check both API keys and account balances.

**Morning briefing not showing weather**
→ Set `WEATHER_API_KEY` and `WEATHER_LOCATION` in `.env`. Weather is optional — if omitted, only the quote and schedule are shown.

**"ZenQuotes fetch failed" in logs**
→ The free ZenQuotes API occasionally goes down. Built-in fallback quotes are used automatically — nothing to worry about.

---

## 📝 Available LLM Tools

The LLM is instructed to use these tool calls to perform actions:

| Tool              | Arguments                                       | What it does                 |
| ----------------- | ----------------------------------------------- | ---------------------------- |
| `create_reminder` | `text`, `time` (ISO-8601), `recurrence?`        | Creates a new reminder       |
| `update_reminder` | `reminder_id`, `text?`, `time?`, `recurrence?`  | Updates an existing reminder |
| `cancel_reminder` | `reminder_id`                                   | Cancels a reminder by ID     |
| `list_reminders`  | _(none)_                                        | Lists all upcoming reminders |
| `create_event`    | `title`, `time` (ISO-8601), `duration_minutes?` | Schedules a calendar event   |
| `add_note`        | `content`                                       | Saves a new note             |
| `get_today`       | _(none)_                                        | Shows today's schedule       |
| `get_briefing`    | _(none)_                                        | Generates morning briefing   |
| `get_quote`       | _(none)_                                        | Fetches a motivational quote |
| `set_fact`        | `key`, `value`                                  | Stores a memory fact         |

---

## 🚀 What's next (v2 ideas)

- Voice messages via Whisper API
- Natural language calendar queries ("What's my week look like?")
- Recurring reminders with custom intervals (every 3 days, etc.)
- Web dashboard for viewing/managing reminders and notes
- Multi-device sync via Telegram sync
- Habit tracking with streaks
- Expense tracking ("Spent RM15 on lunch")

---

## 💰 Running costs

| Service                     | Cost                             |
| --------------------------- | -------------------------------- |
| VPS (e.g. OVHcloud)         | ~€4/month                        |
| PostgreSQL (Neon free tier) | Free                             |
| DeepSeek API                | ~$0.001 per message (very cheap) |
| Xiaomi MiMo (backup only)   | Pay-as-you-go, pennies           |
| Telegram Bot API            | Free                             |
| Redis (optional, local)     | Free                             |

**Total: roughly €4–5/month** for a fully personal AI assistant.
