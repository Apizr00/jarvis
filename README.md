# 🤖 Jarvis — Personal AI Assistant for Telegram

A self-hosted personal AI assistant that lives in your Telegram. Talk to it naturally — set reminders, schedule events, save notes, manage tasks & goals, and let it remember things about you. Wakes you up with a morning briefing complete with weather and a motivational quote. All interactions come with **inline keyboard buttons** for quick actions.

**Stack:** Node.js · PostgreSQL · Redis (optional) · DeepSeek + Xiaomi MiMo · Telegram Bot API

---

## 🏗️ Architecture

```
User
  │
  ▼ Conversation
  │
  ▼ Reasoning (LLM — DeepSeek / MiMo)
  │
  ├── Short-term Memory (10 recent msgs — RAM + DB persistent)
  ├── Long-term Memory (memory_facts with confidence scoring)
  ├── Episodic Memory (chat_history searchable)
  ├── Knowledge Base (notes + semantic memory search RAG)
  ├── User Profile (settings, personality, timezone, language)
  ├── Goals & Tasks (status tracking, progress bars)
  │
  ▼ Memory Retrieval (semantic search — only relevant facts sent to LLM)
  │
  ▼ Tool Calling (create_reminder, add_note, create_task, etc.)
  │
  ▼ Scheduler / Actions (cron: reminders, briefing, reflection, cleanup)
  │
  ▼ Reflection & Learning (daily reflection, pattern recognition, memory cleanup)
```

---

## ✅ What it can do

| You say...                            | Jarvis does...                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| "Remind me to call mum at 6pm"        | Creates a reminder, pings you with `[✅ Done] [🔁 Snooze]` buttons  |
| "Cancel my call mum reminder"         | Cancels the matching reminder by ID                                 |
| "Move my gym reminder to 8am"         | Updates the reminder time                                           |
| "Remind me to stretch every day"      | Creates a recurring daily reminder                                  |
| "Add gym to calendar tomorrow 7am"    | Saves an event with `[✏️ Edit] [❌ Cancel]` buttons                 |
| "Note: look into React Native"        | Saves a note with `[❌ Delete]` button                              |
| "Remember I sleep at 1am"             | Stores a memory fact with confidence scoring + `[❌ Forget]` button |
| "I need to finish the report"         | Creates a task with priority & status tracking                      |
| "Start working on the report"         | Moves task to _In Progress_                                         |
| "Done with report"                    | Marks task as _Done_ 🎉                                             |
| "I want to learn Rust"                | Creates a goal with progress tracking                               |
| "My goal is to lose 5kg by September" | Sets goal with target date + 0-100% progress bar                    |
| "What tasks do I have?"               | Lists all active tasks sorted by priority                           |
| "What are my goals?"                  | Shows goals with progress bars                                      |
| "What's my day?" / `/today`           | Shows today's events + reminders + tasks                            |
| "What do you know about me?"          | Shows stored facts with confidence scores                           |
| "What did we talk about last week?"   | Searches past conversations (episodic memory)                       |
| "Motivate me" / "Give me a quote"     | Fetches a motivational quote from ZenQuotes                         |
| "Search for latest AI news"           | Performs a web search and summarizes results                        |
| 🎤 Send a voice message               | Transcribes via Whisper AI and responds normally                    |
| "What's the weather?"                 | Shows current weather for your configured location                  |
| `/briefing`                           | 🌅 Morning briefing — weather, quote, today's schedule              |
| `/review`                             | 📊 Weekly review — notes, completed tasks, upcoming week            |
| `/reflect`                            | 🧘 Daily reflection — patterns, changes, suggestions                |
| `/reminders`                          | Lists upcoming reminders with `[❌ Cancel]` buttons                 |
| `/tasks`                              | 📋 Lists all active tasks sorted by priority                        |
| `/goals`                              | 🎯 Shows all goals with progress bars                               |
| `/notes`                              | Last 10 notes                                                       |
| `/memory`                             | All stored facts about you                                          |
| `/history <keyword>`                  | 🔍 Search past conversations                                        |
| `/verify`                             | ⚠️ Review & resolve conflicting facts                               |
| `/settings`                           | View current bot name, personality, times, location                 |
| `/status`                             | Check API connections (DeepSeek, MiMo, Whisper, Redis, etc.)        |

### ⚙️ Settings you can change

| Command                | What it changes                    |
| ---------------------- | ---------------------------------- |
| `/setname <name>`      | Bot's display name                 |
| `/setpersonality <t>`  | Bot's personality/tone             |
| `/setlocation <city>`  | Weather location                   |
| `/setbriefing <HH:MM>` | Morning briefing time              |
| `/setreview <HH:MM>`   | Weekly review time (Sunday)        |
| `/revert`              | Revert a setting to previous value |

All setting changes ask for **confirmation** with `[✅ Ya] [❌ Batal]` buttons before applying.

---

## 📋 Requirements

- Node.js **v18+**
- PostgreSQL **v14+** (local or remote)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- A DeepSeek API key (from [platform.deepseek.com](https://platform.deepseek.com))
- Your personal Telegram user ID
- _(Optional)_ Redis **v7+** — caches user facts, bot works without it
- _(Optional)_ Xiaomi MiMo API key — backup LLM fallback if DeepSeek is down
- _(Optional)_ OpenAI API key — enables voice message transcription via Whisper
- _(Optional)_ Tavily API key — enables web search (free: 1,000 searches/month)
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

# OpenAI Whisper (optional — enables voice message transcription)
OPENAI_API_KEY=your_openai_api_key_here
# Force language: "ms" for Malay, "en" for English, or leave blank for auto-detect
WHISPER_LANGUAGE=
# Optional prompt hint for mixed-language / code-switching audio
# WHISPER_PROMPT=English and Bahasa Malaysia mixed conversation

# Web search (optional — enables "search for X" queries)
# Get a free API key at https://tavily.com (1,000 searches/month free)
TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

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

# Bot personality (optional — custom tone for responses)
# BOT_PERSONALITY=You are a helpful and witty assistant. Keep responses short and fun.

# Bot display name (optional — overrides default "Jarvis")
# BOT_NAME=Jarvis

# Morning briefing time (24h format, default 7:00)
MORNING_BRIEFING_TIME=7:00

# Weekly review time (24h format, Sunday, default 20:00)
# WEEKLY_REVIEW_TIME=20:00
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
│   │   ├── mimo.js       # Xiaomi MiMo API provider (backup)
│   │   └── whisper.js    # OpenAI Whisper voice transcription
│   ├── tools/
│   │   ├── index.js      # Tool executor (reminders, events, notes, tasks, goals, etc.)
│   │   ├── quote.js      # Random motivational quote fetcher (ZenQuotes)
│   │   ├── search.js     # Web search via Tavily API
│   │   └── weather.js    # Current weather fetcher (OpenWeatherMap)
│   ├── memory/
│   │   └── index.js      # Semantic search (RAG), auto-extract, confidence, reflection
│   ├── scheduler/
│   │   └── index.js      # Cron: reminders + morning briefing + weekly review + cleanup + reflection
│   ├── api/
│   │   ├── index.js      # REST API server (Express)
│   │   └── status.js     # API health check for /status command
│   ├── redis/
│   │   └── index.js      # Redis cache layer (optional, auto-fallback)
│   ├── db/
│   │   └── index.js      # All PostgreSQL database queries (users, reminders, events, notes, facts, chat_history, tasks, goals, reflections, settings)
│   └── utils/
│       └── datetime.js   # Date/time formatting helpers (dayjs)
├── scripts/
│   └── setup-db.js       # One-time DB table creation + migrations
├── test-all-features.js  # Comprehensive test suite (67 tests, 10 sections)
├── test-briefing.js      # Quick test script for morning briefing
├── .env.example          # Environment variable template
├── package.json
└── README.md
```

---

## 🧪 Testing

Run the comprehensive test suite to verify all features work:

```bash
node test-all-features.js
```

Tests cover 10 sections — semantic search, auto-extract, confidence scoring, conflict resolution, importance scoring, chat history, episodic memory, daily reflection, tasks & goals, and memory cleanup — **67+ assertions** with zero API calls needed.

---

## 🔧 Troubleshooting

**"Missing required environment variables"**
→ Make sure `.env` exists and all 4 required values are filled in.

**"password authentication failed for user jarvis"**
→ Double-check the password in `DATABASE_URL` matches what you set in PostgreSQL.

**Voice messages not working**
→ Set `OPENAI_API_KEY` in `.env` with a valid OpenAI API key.
→ OpenAI's Whisper API costs ~$0.006 per minute of audio.

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

| Tool                | Arguments                                                     | What it does                          |
| ------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `create_reminder`   | `text`, `time` (ISO-8601), `recurrence?`                      | Creates a new reminder                |
| `update_reminder`   | `reminder_id`, `text?`, `time?`, `recurrence?`                | Updates an existing reminder          |
| `cancel_reminder`   | `reminder_id`                                                 | Cancels a reminder by ID              |
| `list_reminders`    | _(none)_                                                      | Lists all upcoming reminders          |
| `create_event`      | `title`, `time` (ISO-8601), `duration_minutes?`               | Schedules a calendar event            |
| `update_event`      | `event_id`, `title?`, `time?`, `duration_minutes?`            | Updates an existing event             |
| `cancel_event`      | `event_id`                                                    | Cancels an event by ID                |
| `add_note`          | `content`                                                     | Saves a new note                      |
| `get_today`         | _(none)_                                                      | Shows today's schedule                |
| `get_briefing`      | _(none)_                                                      | Generates morning briefing            |
| `get_weekly_review` | _(none)_                                                      | Generates weekly review summary       |
| `get_quote`         | _(none)_                                                      | Fetches a motivational quote          |
| `set_fact`          | `key`, `value`                                                | Stores a memory fact                  |
| `web_search`        | `query`                                                       | Searches the web via Tavily           |
| `set_config`        | `key`, `value`                                                | Changes a bot setting                 |
| `revert_config`     | `key`                                                         | Reverts a setting to previous         |
| `create_task`       | `title`, `description?`, `priority?`, `due_date?`, `goal_id?` | Creates a task with status tracking   |
| `update_task`       | `task_id`, `title?`, `description?`, `priority?`, `due_date?` | Updates an existing task              |
| `start_task`        | `task_id`                                                     | Marks task as _In Progress_           |
| `complete_task`     | `task_id`                                                     | Marks task as _Done_                  |
| `cancel_task`       | `task_id`                                                     | Cancels a task                        |
| `list_tasks`        | `status?`                                                     | Lists tasks, optionally by status     |
| `create_goal`       | `title`, `description?`, `target_date?`                       | Creates a goal with progress tracking |
| `update_goal`       | `goal_id`, `title?`, `progress?`, `target_date?`              | Updates goal details/progress         |
| `complete_goal`     | `goal_id`                                                     | Marks goal as _Completed_ (100%)      |
| `abandon_goal`      | `goal_id`                                                     | Abandons a goal                       |
| `list_goals`        | _(none)_                                                      | Shows all goals with progress bars    |

---

## 🔘 Telegram Inline Buttons

Every actionable response comes with inline keyboard buttons — no need to type commands:

| Context                     | Buttons                                 |
| --------------------------- | --------------------------------------- |
| Reminder created / updated  | `[✏️ Edit]` `[❌ Cancel]`               |
| Event created / updated     | `[✏️ Edit]` `[❌ Cancel]`               |
| Note saved                  | `[❌ Delete]`                           |
| Fact remembered             | `[❌ Forget]`                           |
| Task created                | `[🚀 Start]` `[✅ Done]` `[❌ Cancel]`  |
| Goal set                    | `[🏆 Complete]` `[🗑️ Abandon]`          |
| Reminder fires (scheduler)  | `[✅ Done]` `[🔁 Snooze 10m]`           |
| `/reminders` list           | `[❌ Cancel: ...]` per reminder         |
| `/verify` conflicts         | `[✅ Keep]` `[↩️ Restore]` per conflict |
| Setting change confirmation | `[✅ Ya]` `[❌ Batal]`                  |
| `/revert` options           | `[↩️ Setting → prev value]`             |

Clicking **✏️ Edit** stores the item being edited — just type your change naturally (e.g. "tukar ke 3pm") and Jarvis knows exactly which item to update. No need to mention the ID.

Clicking **🔁 Snooze 10m** pushes the reminder forward by 10 minutes and removes the keyboard.

---

## 🧠 Advanced Memory System

Jarvis has a sophisticated memory architecture:

| System                    | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| **Short-term Memory**     | Last 10 messages in RAM + persistent in `chat_history` table               |
| **Long-term Memory**      | Facts stored in `memory_facts` with confidence scores (0.0–1.0)            |
| **Episodic Memory**       | Searchable chat history — ask "what did we talk about last month?"         |
| **Semantic Search (RAG)** | Only relevant facts sent to LLM, not all — saves tokens, improves accuracy |
| **Auto-Extract**          | Facts automatically extracted from conversations in background             |
| **Confidence Scoring**    | Each fact has a confidence score; conflicts are detected & flagged         |
| **Conflict Resolution**   | `/verify` command to review & resolve conflicting information              |
| **Memory Cleanup**        | Daily 3AM job: removes low-importance stale facts, prunes chat > 90 days   |
| **Daily Reflection**      | 10PM: LLM analyzes the day, detects patterns, notes changes, suggests      |
| **Importance Scoring**    | Facts rated 1-10 based on key category, access frequency, recency          |

---

## 🚀 Roadmap

### ✅ Fasa 1 (MVP) — 100% Complete

- ✅ LLM (DeepSeek + MiMo fallback)
- ✅ Short-term memory (persistent chat history)
- ✅ Long-term memory (facts with confidence)
- ✅ Tool calling (15+ tools)
- ✅ Reminders (one-shot + recurring + snooze)
- ✅ Notes
- ✅ Calendar / Events
- ✅ Morning briefing + weekly review
- ✅ Web search + weather + quotes
- ✅ Voice messages (Whisper transcription)

### ✅ Fasa 2 — 100% Complete

- ✅ Episodic memory (`/history`, chat search)
- ✅ Knowledge base (semantic memory search RAG)
- ✅ Daily reflection (`/reflect` + auto 10PM)
- ✅ Task management (status tracking, priority, inline buttons)
- ✅ Goal management (progress tracking, target dates)

### ⬜ Fasa 3 — Future

- ⬜ Pattern recognition (dedicated system beyond LLM reflection)
- ⬜ Relationship memory (dedicated table for people you mention)
- ⬜ Document input (PDF, images, location)
- ⬜ Habit tracking with streaks
- ⬜ Expense tracking
- ⬜ Voice reply (TTS)
- ⬜ Multi-user support
- ⬜ Web dashboard

---

## 💰 Running costs

| Service                     | Cost                             |
| --------------------------- | -------------------------------- |
| VPS (e.g. OVHcloud)         | ~€4/month                        |
| DeepSeek API                | ~$0.14 / 1M input tokens         |
| Xiaomi MiMo (backup only)   | Pay-as-you-go, pennies           |
| OpenAI Whisper (voice only) | ~$0.006/min of audio             |
| PostgreSQL (Neon free tier) | Free (10 GB storage)             |
| Tavily Search (web search)  | Free tier (1,000 searches/month) |
| OpenWeatherMap (weather)    | Free tier (1,000 calls/day)      |
| Telegram Bot API            | Free                             |
| Redis (optional, local)     | Free                             |

**Total: roughly €4–5/month** for a fully personal AI assistant.
