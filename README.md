# 🤖 Jarvis — Personal AI Assistant for Telegram

A self-hosted AI assistant that lives in your Telegram. Talk naturally — reminders, calendar, notes, tasks, goals, web search, voice messages, and **proactive check-ins**. Powered by a **5-layer executive architecture** for intelligent, context-aware responses.

**Stack:** Node.js · PostgreSQL · Redis (optional) · DeepSeek + MiMo · Telegram Bot API

---

## 🧠 Architecture (5 Fasa + Anti-Hallucination)

```
User Message
    │
    ▼
┌─────────────────────────────────────────────┐
│  FASA 1: Executive + Intent Detection        │
│  Mood, urgency, language, category detection │
│  12 intent categories with confidence score  │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  FASA 2: Working Memory + World Model        │
│  User state, active domain, time patterns    │
│  Auto-derives: status, domain, energy level  │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  FASA 3: Structured Memory Domains           │
│  8 domains: personal, work, health,          │
│  learning, social, finance, schedule, goals  │
│  Cross-domain relationships tracked          │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  FASA 4: Planning Layer                      │
│  Task decomposition, step dependencies,      │
│  progress tracking, stalled plan detection   │
│  Next-best-action suggestions                │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  FASA 5: Self Evaluation + Proactive Chat    │
│  Response quality scoring, learning tracker, │
│  Auto check-ins (morning/evening/goal nudge) │
│  Fast reflection after deep interactions     │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  🛡️ ANTI-HALLUCINATION VALIDATOR             │
│  Action detection · Time verification        │
│  Reminder fabrication check · DB cross-ref   │
│  Fallback generation if hallucination found  │
└──────────────────┬──────────────────────────┘
                   ▼
         ✅ Safe LLM Response
         (DeepSeek / MiMo fallback)
```

---

## ✨ Highlights

- **🧠 5-Fasa Executive Architecture** — Layered intelligence: intent → world model → domains → planning → self-eval + proactive
- **�️ Anti-Hallucination Validator** — Multi-layer response validation catches & prevents fabricated actions, times, reminders, and facts before they reach you
- **�📊 Pattern Recognition** — Dedicated non-LLM system detecting usage, topics, behavior, trends, correlations — zero API cost
- **👥 Relationship Memory** — Auto-extracts names, relationships, context from conversations
- **🎤 Voice Messages** — Transcribed via OpenAI Whisper, processed like text
- **🌐 Web Search** — Real-time info summarized in your language (BM/EN/Rojak)
- **📋 Planning Layer** — Break goals into steps with dependencies and progress tracking
- **💬 Proactive Chat** — Bot initiates conversation based on time, goals, mood patterns
- **📈 Self Evaluation** — Bot scores its own responses and learns over time
- **🧘 Daily Reflection** — LLM-generated end-of-day summary with patterns and suggestions

---

## ✅ What it can do

| You say...                         | Jarvis does...                                                      |
| ---------------------------------- | ------------------------------------------------------------------- |
| "Remind me to call mum at 6pm"     | Creates a reminder, pings you with `[✅ Done] [🔁 Snooze]` buttons  |
| "Cancel my call mum reminder"      | Cancels the matching reminder by ID                                 |
| "Remind me to stretch every day"   | Creates a recurring daily reminder                                  |
| "Add gym to calendar tomorrow 7am" | Saves an event with `[✏️ Edit] [❌ Cancel]` buttons                 |
| "Note: look into React Native"     | Saves a note with `[❌ Delete]` button                              |
| "Remember I sleep at 1am"          | Stores a memory fact with confidence scoring + `[❌ Forget]` button |
| "I need to finish the report"      | Creates a task with priority & status tracking                      |
| "Done with report"                 | Marks task as _Done_ 🎉                                             |
| "I want to learn Rust"             | Creates a goal with progress tracking                               |
| "Plan: learn Python in 2 weeks"    | **Fasa 4:** Breaks into steps with dependencies                     |
| "What's my plan progress?"         | Shows active plan with completion % and next step                   |
| "What domain am I in?"             | **Fasa 3:** Shows active memory domain (work/health/learning...)    |
| "How am I doing?"                  | **Fasa 5:** Bot self-evaluates and shows interaction stats          |
| _(Bot initiates)_                  | **Fasa 5:** Proactive morning/evening check-ins, goal nudges        |
| "What tasks do I have?"            | Lists all active tasks sorted by priority                           |
| "What are my goals?"               | Shows goals with progress bars                                      |
| "What's my day?" / `/today`        | Shows today's events + reminders + tasks                            |
| "What do you know about me?"       | Shows stored facts with confidence scores                           |
| "My wife Sarah is a doctor"        | Auto-extracts person into relationship memory 👥                    |
| "Search for latest AI news"        | Performs a web search and summarizes results in your language       |
| 🎤 Send a voice message            | Transcribes via Whisper AI and responds normally                    |
| "What's the weather?"              | Shows current weather for your configured location                  |
| `/briefing`                        | 🌅 Morning briefing — weather, quote, today's schedule              |
| `/review`                          | 📊 Weekly review — notes, completed tasks, upcoming week            |
| `/reflect`                         | 🧘 Daily reflection — patterns, changes, suggestions                |
| `/patterns`                        | 🔍 View detected behavioral patterns (usage, topics, trends)        |
| `/reminders`                       | Lists upcoming reminders with `[❌ Cancel]` buttons                 |
| `/tasks`                           | 📋 Lists all active tasks sorted by priority                        |
| `/goals`                           | 🎯 Shows all goals with progress bars                               |
| `/notes`                           | Last 10 notes                                                       |
| `/memory`                          | All stored facts about you                                          |
| `/people`                          | 👥 All remembered people & their relationships                      |
| `/person <name>`                   | 🔍 Search for a specific person by name                             |
| `/history <keyword>`               | 🔍 Search past conversations                                        |
| `/verify`                          | ⚠️ Review & resolve conflicting facts                               |
| `/plan`                            | **Fasa 4:** Active plans with steps, progress, next action          |
| `/domains`                         | **Fasa 3:** Memory organized by 8 domains (work, health, etc.)      |
| `/evaluate`                        | **Fasa 5:** Self-evaluation stats & learning summary                |
| `/proactive`                       | **Fasa 5:** Trigger a proactive suggestion (check-in, nudge)        |
| `/state`                           | **All Fasa:** Full bot state report (world model + plans + stats)   |
| `/settings`                        | View current bot name, personality, times, location                 |
| `/status`                          | Check API connections (DeepSeek, MiMo, Whisper, Redis, etc.)        |

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

## � Pattern Recognition (Non-LLM)

Jarvis has a **dedicated pattern recognition system** that runs entirely without LLM — algorithmically detecting patterns from your usage data. This means zero API cost and instant results.

### 5 Pattern Categories

| Category           | What it detects                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📊 **Usage**       | Peak activity hours, preferred days, weekday/weekend split, consistency, activity trends                                                                                         |
| 💬 **Topic**       | Frequently discussed keywords, thematic groups (work, health, social, finance, tech...), co-occurring word clusters, language mix (EN/BM), message complexity                    |
| 🔄 **Behavior**    | Reminder categories (work, health, family...), reminder time clustering, task completion rate, priority distribution, note-taking frequency, favorite features, goal achievement |
| 📈 **Trend**       | Activity spikes/dips, engagement growth/decline, reminder adherence, task backlog, new feature adoption                                                                          |
| 🔗 **Correlation** | Time-of-day ↔ topic correlations (e.g. "work topics discussed in mornings", "entertainment in evenings")                                                                         |

### How it works

- **Incremental tracking** — Every message is tracked with extracted keywords. Lightweight analysis runs every 10 messages.
- **Daily full analysis** — Scheduled at 11 PM. Runs all detectors across 30 days of data.
- **Confidence-scored** — Each pattern has a 0-1 confidence, displayed as a visual bar (e.g. `████░ 85%`).
- **Self-cleaning** — Patterns expire after 7 days if not re-confirmed by new data.

### Commands

- `/patterns` — View all detected patterns
- `/patterns usage|topic|behavior|trend|correlation` — Filter by type

---

## 👥 Relationship Memory

A dedicated table for **people you mention** in conversations. Unlike facts (which are about YOU), this is about **others** — family, friends, colleagues, anyone.

### Auto-Extraction

Every time you chat, the LLM scans for people mentioned:

- _"My wife Sarah is a doctor"_ → Extracts: Sarah, wife, works as a doctor
- _"Meeting with boss Rahman tomorrow"_ → Extracts: Rahman, boss
- _"Call mum later"_ → Extracts: mum, family

Extracted data flows into the system prompt, so the LLM **already knows who these people are** when you reference them later.

### What's stored per person

| Field           | Example                                                |
| --------------- | ------------------------------------------------------ |
| `name`          | Sarah                                                  |
| `relationship`  | wife                                                   |
| `context`       | Sarah is the user's wife, she works as a doctor at HKL |
| `confidence`    | 0.9                                                    |
| `mention_count` | 5                                                      |

### Commands

- `/people` — List all remembered people with relationships
- `/person Sarah` — Search for a specific person
- Or naturally: _"Remember that Ali is my project manager"_ (uses `save_relationship` tool)

---

## �📋 Requirements

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
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝

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

## 🛡️ Anti-Hallucination System

Jarvis includes a **multi-layer anti-hallucination validator** that runs after every LLM response, catching and fixing fabricated information before it reaches you:

| Validation Layer         | What it catches                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------ |
| **Action Detection**     | Bot claiming "Done! Dah set reminder" without actually calling a tool                |
| **Time Verification**    | Bot mentioning wrong times (e.g., "pukul 6:36 am" when it's 8:00 PM)                 |
| **Reminder Fabrication** | Bot inventing reminder IDs/times — cross-references with actual DB records           |
| **Fact Hallucination**   | Bot making up facts about the user not in memory — triggers "I don't have that info" |
| **Tool Parameter Check** | Validates all tool call parameters before execution — catches missing/invalid args   |
| **Fallback Generation**  | Auto-replaces hallucinated responses with safe clarifying questions or tool calls    |

**Key files:**

- `src/llm/validator.js` — Core validation engine (50+ detection rules)
- `src/bot/index.js` — Time hallucination guard with `fixHallucinatedTime()`
- `src/tools/index.js` — Tool parameter schema validation
- `src/llm/shared.js` — Enhanced system prompt with anti-fabrication rules

📖 See **[ANTI-HALLUCINATION-IMPROVEMENTS.md](ANTI-HALLUCINATION-IMPROVEMENTS.md)** for full technical details.

---

## 🧠 LLM Fallback Architecture

Jarvis uses a primary + backup LLM setup with validation at every stage:

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
       │      ├── enhanced system prompt
       │      ├── response parsed
       │      └── 🛡️ validator checks →
       │
       └── 2️⃣ Xiaomi MiMo (backup)
              ├── enhanced system prompt
              ├── response parsed
              └── 🛡️ validator checks →
                                           │
                                      ┌────▼────┐
                                      │  Safe   │
                                      │ Response│
                                      └─────────┘
```

- **Redis cache** sits in front of both providers — user facts are cached for 10 minutes, reducing DB load on every message
- If Redis is unavailable, the bot still works — just queries PostgreSQL directly
- Set `MIMO_API_KEY` in `.env` to activate the backup. Skip it and only DeepSeek is used
- The validator runs on ALL responses from ALL providers — hallucination protection is universal

---

## 🧠 The 5 Fasa — How it Thinks

| Fasa  | Layer                        | What it does                                                                                                                                                                                          |
| ----- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Intent Detection             | Classifies every message into 12 categories with confidence. Detects mood (happy/sad/tired/anxious/motivated), urgency level, and language (BM/EN/Rojak). Routes to fast/medium/deep processing tier. |
| **2** | Working Memory + World Model | Tracks active goals, possible solutions, rejected ideas. Derives user status from time of day (sleeping/working/free). Detects which life domain is active (work/health/learning...).                 |
| **3** | Memory Domains               | Organizes all stored facts into 8 structured domains. Detects cross-domain relationships (e.g., work→schedule, health→work). Builds domain-aware context for better LLM responses.                    |
| **4** | Planning Layer               | Breaks complex goals into steps with dependencies. Tracks progress 0-100%. Detects stalled plans (>12h inactive). Suggests next-best-action based on priority and readiness.                          |
| **5** | Self Evaluation + Proactive  | Scores every response for quality (length, hallucination, actionability). Records interaction stats. Initiates conversation: morning check-in, evening reflection, goal nudges, mood support.         |

### Proactive Check-in Examples

| Trigger              | Bot says                                         |
| -------------------- | ------------------------------------------------ |
| 7-9 AM               | ☀️ "Selamat pagi! Ada plan untuk hari ni?"       |
| 8-10 PM              | 🌙 "Dah malam! Nak reflection atau plan esok?"   |
| Stalled plan >12h    | ⏰ "Plan ni dah 12 jam tak update. Nak sambung?" |
| Goal progress <50%   | 📋 "Quick check-in on your goal..."              |
| Mood: tired detected | 😴 "Nampak macam penat. Jangan lupa rehat!"      |
| Weekend morning      | 🎉 "Weekend! Ada plan best ke?"                  |

---

## 🗂️ Project Structure

```
jarvis/
├── src/
│   ├── index.js              # Entry point — boots bot, API, scheduler
│   ├── bot/
│   │   └── index.js           # Telegram bot — all commands + message processing
│   ├── executive/             # 🧠 5-Fasa Executive Architecture
│   │   ├── index.js           # Controller — orchestrates all 5 Fasa
│   │   ├── intent-engine.js   # Fasa 1: Advanced intent + mood + urgency + language
│   │   ├── working-memory.js  # Fasa 2: Brain scratchpad (goal, solutions, steps)
│   │   ├── world-model.js     # Fasa 2: User state (status, domain, time patterns)
│   │   ├── planner.js         # Fasa 4: Task decomposition + dependencies + progress
│   │   ├── evaluator.js       # Fasa 5: Response quality scoring + learning tracker
│   │   └── proactive.js       # Fasa 5: Auto check-ins + smart nudges
│   ├── llm/
│   │   ├── index.js           # LLM Router (DeepSeek ←→ MiMo auto-fallback)
│   │   ├── shared.js          # System prompt builder + tool normalization
│   │   ├── deepseek.js        # DeepSeek API provider (primary)
│   │   ├── mimo.js            # Xiaomi MiMo API provider (backup)
│   │   ├── intent.js          # Legacy fast keyword-based intent detection
│   │   ├── validator.js       # Anti-hallucination response validator
│   │   └── whisper.js         # OpenAI Whisper voice transcription
│   ├── memory/
│   │   ├── index.js           # Semantic search (RAG) + auto-extract facts
│   │   ├── domains.js         # Fasa 3: 8 structured memory domains + relationships
│   │   └── relationships.js   # 👥 People memory — auto-extract + search
│   ├── tools/
│   │   ├── index.js           # Tool executor — 20+ tools + param validation
│   │   ├── quote.js           # Motivational quotes (ZenQuotes)
│   │   ├── search.js          # Web search via Tavily API
│   │   └── weather.js         # Weather fetcher (OpenWeatherMap)
│   ├── patterns/              # 🔍 Non-LLM pattern recognition
│   │   ├── index.js           # Core: tracking, full/incremental analysis
│   │   ├── shared.js          # Keyword extraction, math utils
│   │   └── detectors/         # usage.js, topics.js, behavior.js, trends.js
│   ├── scheduler/
│   │   └── index.js           # Cron: reminders + briefing + review + patterns + proactive + eval
│   ├── api/
│   │   ├── index.js           # REST API server (Express)
│   │   └── status.js          # API health check formatter
│   ├── redis/
│   │   └── index.js           # Redis cache layer (optional)
│   ├── db/
│   │   └── index.js           # All PostgreSQL queries (14 tables)
│   └── utils/
│       └── datetime.js        # Date/time helpers (dayjs)
├── scripts/
│   └── setup-db.js            # One-time DB table creation + migrations
├── test-all-phases.js         # 🧪 46 tests — all 5 Fasa modules
├── test-all-features.js       # 🧪 67 tests — full feature coverage
├── test-briefing.js           # Quick morning briefing test
├── test-executive.js          # Executive controller + intent engine tests
├── test-perf-improvements.js  # Performance & anti-hallucination validation tests
├── TESTING-GUIDE.md           # 📖 Step-by-step anti-hallucination testing guide
├── ANTI-HALLUCINATION-IMPROVEMENTS.md # 📖 Full anti-hallucination technical docs
├── CHANGES-SUMMARY.md         # 📖 Summary of latest code changes
├── .env.example               # Environment variable template
├── package.json
└── README.md
```

---

## 🧪 Testing

```bash
node test-all-phases.js      # 46 tests — all 5 Fasa modules
node test-all-features.js    # 67 tests — full feature coverage
node test-briefing.js        # Quick morning briefing test
node test-executive.js       # Executive controller tests
node test-perf-improvements.js # Performance improvements validation
```

Tests cover 10 sections — semantic search, auto-extract, confidence scoring, conflict resolution, importance scoring, chat history, episodic memory, daily reflection, tasks & goals, and memory cleanup — **67+ assertions** with zero API calls needed.

📖 See **[TESTING-GUIDE.md](TESTING-GUIDE.md)** for step-by-step anti-hallucination testing scenarios.

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

**"⚠️ Hallucination detected" in logs**
→ This is GOOD — it means the anti-hallucination validator caught a fabricated response before it was sent. The bot automatically replaces it with a safe response. If you see many of these, check your LLM API account balance.

**"⏰ Fixing hallucinated time" in logs**
→ The time guard corrected a wrong time mentioned by the LLM. The bot auto-fixes it — no action needed.

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

## 💰 Kos Bulanan (Running Costs)

| Servis                        | Kos                                |
| ----------------------------- | ---------------------------------- |
| VPS (contoh: OVHcloud)        | ~RM20/bulan (~$4)                  |
| DeepSeek API                  | ~RM0.62 / 1M input tokens (~$0.14) |
| Xiaomi MiMo (backup sahaja)   | Pay-as-you-go, sen-sen je          |
| OpenAI Whisper (suara sahaja) | ~RM0.03/min audio (~$0.006)        |
| PostgreSQL (Neon free tier)   | Percuma (10 GB storage)            |
| Tavily Search (web search)    | Free tier (1,000 carian/bulan)     |
| OpenWeatherMap (cuaca)        | Free tier (1,000 panggilan/hari)   |
| Telegram Bot API              | Percuma                            |
| Redis (optional, lokal)       | Percuma                            |

**Jumlah: lebih kurang RM20–25/bulan** untuk pembantu AI peribadi sepenuhnya.
