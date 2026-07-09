# 🤖 Jarvis — Personal AI Assistant for Telegram

A self-hosted AI assistant that lives in your Telegram. Talk naturally — reminders, calendar, notes, tasks, goals, web search, voice, image analysis, and **proactive check-ins**.

**Stack:** Node.js · PostgreSQL · Redis · ILMU (YTL) + DeepSeek + MiMo · Telegram Bot API

---

## 🆕 v4.0 — What's New

- **🛡️ Anti-Hallucination v2** — 12-category human fact hallucination detection (location, schedule, health, emotions, relationships, finances, knowledge, predictions, intent, numbers, identity). Web search hallucination guard with 3-layer defense.
- **🧠 Memory Hierarchy** — 3-tier system: Short-term (Redis, <1ms), Working (process+Redis, 2h), Long-term (Postgres). Cross-session learning with session summaries and pattern accumulation.
- **📋 Advanced Task Planning** — Hierarchical goal decomposition, temporal reasoning with critical path calculation, resource allocation, and execution monitoring with auto-recovery suggestions.
- **📊 Analytics & Insights** — Behavioral prediction, comprehensive performance dashboard (latency/accuracy/engagement/tools), A/B testing framework, user journey mapping.
- **💬 Enhanced Communication** — Multi-platform abstraction (WhatsApp/Discord ready), conversation thread context management, adaptive communication style detection, NLG response enhancement pipeline.
- **🔌 Plugin System** — Drop-in plugins with plugin.json manifest. 8 hook types, hot-reload, isolated context.
- **📡 Event Bus** — Pub/sub with 24 events, middleware, async isolation.
- **🤖 Agent Layer** — 5 autonomous agents with retry, timeout, and validation.

---

## ✨ What It Can Do

| You say...                         | Jarvis does...                                          |
| ---------------------------------- | ------------------------------------------------------- |
| "Remind me to call mum at 6pm"     | Creates a reminder with `[✅ Done] [🔁 Snooze]` buttons |
| "Add gym to calendar tomorrow 7am" | Saves an event with `[✏️ Edit] [❌ Cancel]` buttons     |
| "Note: look into React Native"     | Saves a note with `[❌ Delete]` button                  |
| "Remember I sleep at 1am"          | Stores a memory fact with confidence scoring            |
| "I want to learn Rust"             | Creates a goal with progress tracking                   |
| "Plan: learn Python in 2 weeks"    | Auto-decomposes into sub-goals with steps               |
| "Search for latest AI news"        | Web search → summarizes in your language                |
| "What's my day?"                   | Today's events + reminders + tasks                      |
| "What tasks do I have?"            | Active tasks sorted by priority                         |
| "What do you know about me?"       | Stored facts with confidence scores                     |
| 🖼️ Send a photo                    | AI image analysis via ILMU Vision                       |
| 🎤 Send a voice message            | Transcribes via ILMU ASR or Whisper                     |
| `/speak <text>`                    | Converts text to voice note via ILMU TTS                |
| "What's the weather?"              | Current weather for your location                       |
| "My wife Sarah is a doctor"        | Auto-extracts person into relationship memory           |

---

## 📋 Commands

### Core

| Command              | Description                                    |
| -------------------- | ---------------------------------------------- |
| `/start`             | Welcome message                                |
| `/today`             | Today's events + reminders + tasks             |
| `/briefing`          | 🌅 Morning briefing — weather, quote, schedule |
| `/reminders`         | Upcoming reminders with `[❌ Cancel]`          |
| `/tasks`             | Active tasks sorted by priority                |
| `/goals`             | Goals with progress bars                       |
| `/notes`             | Recent notes                                   |
| `/memory`            | All stored facts                               |
| `/people`            | Remembered people & relationships              |
| `/person <name>`     | Search for a specific person                   |
| `/history <keyword>` | Search past conversations                      |
| `/verify`            | Review & resolve conflicting facts             |
| `/plan`              | Active plans with steps + progress             |
| `/domains`           | Memory organized by 8 domains                  |

### Tools & Analysis

| Command            | Description                              |
| ------------------ | ---------------------------------------- |
| `/status`          | API health (ILMU, DeepSeek, MiMo, Redis) |
| `/state`           | Full bot state report                    |
| `/queue`           | Job queue system stats                   |
| `/evaluate`        | Self-evaluation stats                    |
| `/proactive`       | Trigger proactive suggestion             |
| `/lifecycle`       | Conversation phase + engagement          |
| `/why`             | Trace last bot decision                  |
| `/trace [N]`       | Last N execution traces + latency        |
| `/patterns [type]` | Detected behavioral patterns             |
| `/reflect`         | Daily reflection — patterns, changes     |
| `/review`          | Weekly review summary                    |

### Media

| Command         | Description                  |
| --------------- | ---------------------------- |
| `/speak <text>` | 🎤 Text-to-speech voice note |
| Send photo      | 🖼️ AI image analysis         |
| Send voice      | 🎙️ Voice transcription       |

### Settings

| Command                  | Description                 |
| ------------------------ | --------------------------- |
| `/settings`              | View current settings       |
| `/setname <name>`        | Change bot name             |
| `/setpersonality <text>` | Change bot personality/tone |
| `/setlocation <city>`    | Weather location            |
| `/setbriefing <HH:MM>`   | Morning briefing time       |
| `/setreview <HH:MM>`     | Weekly review time (Sunday) |
| `/revert`                | Revert a setting            |

---

## 🧠 Architecture

```
User Message
    │
    ▼
┌─────────────────────────────────────────┐
│  📡 EVENT BUS — 24 events, pub/sub      │
└──────────────────┬──────────────────────┘
                   ▼
┌─────────────────────────────────────────┐
│  🧠 EXECUTIVE — Intent, mood, language   │
│  ⚡ Tier routing: fast→ILMU, med→MiMo,  │
│  deep→DeepSeek with auto-fallback       │
└──────────────────┬──────────────────────┘
                   ▼
┌─────────────────────────────────────────┐
│  🧠 MEMORY — 3-tier hierarchy            │
│  🔴 STM (Redis <1ms) / 🟡 WM (2h) /     │
│  🟢 LTM (Postgres, compressed)          │
│  8 domains + cross-session learning      │
└──────────────────┬──────────────────────┘
                   ▼
┌─────────────────────────────────────────┐
│  📋 PLANNER — Hierarchical decomposition │
│  Temporal reasoning, resource allocation │
│  Execution monitoring + recovery         │
└──────────────────┬──────────────────────┘
                   ▼
┌─────────────────────────────────────────┐
│  🛡️ ANTI-HALLUCINATION — 3-layer defense │
│  Actions, times, reminders, web search,  │
│  12 human fact categories, fact lock     │
└──────────────────┬──────────────────────┘
                   ▼
┌─────────────────────────────────────────┐
│  🧠 STATE MACHINE — Explicit flow        │
│  idle→intent→memory→tools→response→done │
│  📊 Observability: traces, logs, latency │
└──────────────────┬──────────────────────┘
                   ▼
       ✅ Safe, Traceable Response
```

---

## 🛡️ Anti-Hallucination System

**3-layer defense** runs on every LLM response:

| Category                        | What It Catches                                                                                                               | Action                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Actions**                     | "Done! Saya dah set reminder" without tool call                                                                               | Block + Retry               |
| **Limitations**                 | "Cannot access reminders" — this is a lie                                                                                     | Block + Retry               |
| **Reminder Lists**              | LLM invents reminder list instead of calling tool                                                                             | Replace with list_reminders |
| **Web Search**                  | Answers weather/news/price without searching                                                                                  | Block + Force web_search    |
| **Time**                        | Wrong times, wrong greetings, time math errors                                                                                | Auto-fix                    |
| **Human Facts (12 categories)** | Location, schedule, preferences, health, emotions, relationships, finances, knowledge, predictions, intent, numbers, identity | Block + neutral response    |
| **Fact Lock**                   | ✅ verified → assert / ⚠️ inferred → hedge / ❓ uncertain → question                                                          | Control assertion level     |

---

## 🗂️ Project Structure

```
jarvis/
├── src/
│   ├── index.js                 # Entry point
│   ├── bot/
│   │   ├── index.js             # Telegram bot — messages + commands
│   │   ├── anti-hallucination.js # Greeting + time hallucination fixers
│   │   ├── history.js           # Conversation history, summarization
│   │   └── communication.js     # Multi-platform, context threads, adaptive style
│   ├── executive/               # 🧠 Decision engine
│   │   ├── index.js             # Controller — orchestrates all modules
│   │   ├── intent-engine.js     # Intent + mood + language detection
│   │   ├── working-memory.js    # Brain scratchpad (+ Redis persistence)
│   │   ├── world-model.js       # User state + domain awareness
│   │   ├── planner.js           # Task decomposition + dependencies
│   │   ├── advanced-planner.js  # 🆕 Hierarchy, temporal, resources, monitoring
│   │   ├── evaluator.js         # Response quality scoring
│   │   ├── proactive.js         # 5D opportunity-scored check-ins
│   │   ├── cascade.js           # Smart follow-up after tool execution
│   │   ├── state-machine.js     # Explicit state flow + tracing
│   │   ├── lifecycle.js         # Conversation phase manager
│   │   └── persistence.js       # Auto-save/restore runtime state
│   ├── llm/
│   │   ├── index.js             # LLM Router with fallback
│   │   ├── shared.js            # System prompt builder + fact lock
│   │   ├── validator.js         # 🛡️ Anti-hallucination (15 detectors)
│   │   ├── nlg.js               # 🆕 NLG enhancement pipeline
│   │   ├── ilmu.js              # ILMU (primary BM)
│   │   ├── deepseek.js          # DeepSeek (deep reasoning)
│   │   ├── mimo.js              # MiMo (backup)
│   │   ├── embeddings.js        # BGE-M3 semantic search
│   │   ├── vision.js            # Image analysis
│   │   ├── tts.js               # Text-to-speech
│   │   └── whisper.js           # Voice transcription
│   ├── memory/
│   │   ├── index.js             # RAG search + importance scoring
│   │   ├── hierarchy.js         # 🆕 3-tier memory (STM/WM/LTM)
│   │   ├── domains.js           # 8 structured memory domains
│   │   └── relationships.js     # People memory
│   ├── patterns/
│   │   ├── index.js             # Non-LLM pattern recognition
│   │   ├── analytics.js         # 🆕 Prediction, metrics, A/B, journey
│   │   └── detectors/           # usage, topics, behavior, trends
│   ├── tools/                   # 25+ tools + validation
│   ├── plugins/                 # Plugin system
│   ├── agents/                  # 5 autonomous agents
│   ├── events/                  # Event bus
│   ├── scheduler/               # Cron jobs
│   ├── api/                     # REST API server
│   ├── redis/                   # Cache layer
│   ├── queue/                   # Job queue (BullMQ)
│   ├── db/                      # All PostgreSQL queries
│   └── utils/                   # Date/time, observability, retry
├── plugins/                     # Drop-in plugin directory
├── scripts/setup-db.js          # DB table creation
├── package.json
└── README.md
```

---

## 🚀 Setup

1. **Clone & install**

   ```bash
   git clone <repo>
   cd jarvis
   npm install
   ```

2. **Configure `.env`**

   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_OWNER_ID=your_telegram_id
   DATABASE_URL=postgres://...
   REDIS_URL=redis://localhost:6379
   DEEPSEEK_API_KEY=sk-...
   ILMU_API_KEY=your_ilmu_key
   OPENAI_API_KEY=sk-...          # Optional: Whisper fallback
   TAVILY_API_KEY=tvly-...        # Optional: Web search
   WEATHER_API_KEY=...            # Optional: Weather
   TIMEZONE=Asia/Kuala_Lumpur
   ```

3. **Setup database**

   ```bash
   node scripts/setup-db.js
   ```

4. **Run**
   ```bash
   npm start
   ```

---

## 🧪 Testing

```bash
node test-max-capability.js   # 125 assertions — all features at max depth
node test-scenarios.js        # 106 assertions — 12 user journey simulations
node test-all-features.js     # Full feature coverage
node test-all-phases.js       # All executive modules
node test-queue-benchmark.js  # Queue before/after benchmark
```
