# 🤖 Jarvis — Personal AI Assistant for Telegram

A self-hosted AI assistant that lives in your Telegram. Talk naturally — reminders, calendar, notes, tasks, goals, web search, voice messages, and **proactive check-ins**. Powered by a **9-phase upgrade architecture** for intelligent, context-aware, observable, and safe responses.

**Stack:** Node.js · PostgreSQL · Redis (optional) · DeepSeek + MiMo · Telegram Bot API

---

## 🧠 Architecture (5 Fasa + 9 Phase Upgrades)

```
User Message
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  🔄 CONVERSATION LIFECYCLE MANAGER                        │
│  onboarding → idle → active_task → dormant → reactivation │
│  Phase-aware messaging policy + engagement tracking       │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  FASA 1: Executive + Intent Detection                     │
│  Mood, urgency, language, category detection              │
│  12 intent categories with confidence score               │
│  ⚡ TIER ROUTING: fast → MiMo / deep → DeepSeek           │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  FASA 2: Working Memory + World Model                     │
│  User state, active domain, time patterns                 │
│  Auto-derives: status, domain, energy level               │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  FASA 3: Structured Memory Domains                        │
│  8 domains: personal, work, health, learning, social,     │
│  finance, schedule, goals                                 │
│  💾 MEMORY WRITE STRATEGY: importance scoring,            │
│  exponential decay, conflict resolution, compression      │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  FASA 4: Planning Layer                                   │
│  Task decomposition, step dependencies, progress tracking │
│  Stalled plan detection, next-best-action suggestions     │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  FASA 5: Self Evaluation + Proactive Chat                 │
│  Response quality scoring, learning tracker               │
│  📊 OPPORTUNITY SCORING: userState + timing +             │
│  pastBehavior + goalProximity → 0-100 decision score       │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  ⚖️  TOOL ARBITRATION LAYER                                │
│  Conflict detection · Priority ranking · Fallback chains  │
│  Dependency resolution · Smart execution plan             │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  🛡️ ANTI-HALLUCINATION VALIDATOR + 🔒 FACT LOCK          │
│  Action · Time · Reminder · Fact detection                │
│  Fact tiers: ✅ verified / ⚠️ inferred / ❓ uncertain     │
│  Fallback generation if hallucination found               │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  🧠 STATE MACHINE (explicit execution flow)               │
│  idle → intent_detected → memory_loaded → plan_created    │
│  → tools_executed → response_evaluated → completed         │
│  📊 OBSERVABILITY: spans, prompt logs, tool logs, latency │
└────────────────────┬─────────────────────────────────────┘
                     ▼
         ✅ Safe, Traceable LLM Response
         (DeepSeek / MiMo with 💰 cost+latency optimizer)
```

---

## ✨ Highlights

- **🧠 5-Fasa Executive + 9 Phase Upgrades** — Production-grade architecture: state machine, observability, fact lock, lifecycle, memory strategy, cost optimizer, proactive scoring, tool arbitration
- **🔄 Conversation Lifecycle** — 5 phases (onboarding→idle→active_task→dormant→reactivation) with per-phase messaging policies
- **🧠 State Machine** — Explicit execution flow with `/why` command to trace every decision
- **📊 Observability Layer** — Execution spans, prompt/tool/memory logs, per-phase latency tracking
- **🔒 Fact Lock System** — 3-tier fact classification (verified/inferred/uncertain) controls LLM assertion confidence
- **💾 Memory Write Strategy** — Importance scoring, exponential decay, conflict resolution, old fact compression
- **💰 LLM Cost Optimizer** — Token estimation, cost prediction, latency-aware routing, timeout budgets per tier
- **📊 Proactive Opportunity Scoring** — 4D decision engine: user state + timing + past behavior + goal proximity
- **⚖️ Tool Arbitration** — Conflict detection, priority ranking, fallback chaining, dependency resolution
- **🛡️ Anti-Hallucination** — Multi-layer validator catches fabricated actions, times, reminders, facts
- **🔍 Pattern Recognition** — Non-LLM system detecting usage, topics, behavior, trends (zero API cost)
- **👥 Relationship Memory** — Auto-extracts names, relationships, context from conversations
- **🎤 Voice Messages** — Transcribed via OpenAI Whisper, processed like text
- **🌐 Web Search** — Real-time info summarized in your language (BM/EN/Rojak)
- **📋 Planning Layer** — Break goals into steps with dependencies and progress tracking
- **💬 Proactive Chat** — Bot initiates conversation based on opportunity scores, not just time
- **🧘 Daily Reflection** — LLM-generated end-of-day summary with patterns and suggestions
- **🧪 360+ Test Assertions** — Scenario-driven user journey tests + max capability validation

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
| _(Bot initiates)_                  | **Fasa 5:** Proactive check-ins based on opportunity scores         |
| "What tasks do I have?"            | Lists all active tasks sorted by priority                           |
| "What are my goals?"               | Shows goals with progress bars                                      |
| "What's my day?" / `/today`        | Shows today's events + reminders + tasks                            |
| "What do you know about me?"       | Shows stored facts with confidence scores                           |
| "My wife Sarah is a doctor"        | Auto-extracts person into relationship memory 👥                    |
| "Search for latest AI news"        | Performs a web search and summarizes results in your language       |
| 🎤 Send a voice message            | Transcribes via Whisper AI and responds normally                    |
| "What's the weather?"              | Shows current weather for your configured location                  |

---

## 📋 All Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + feature intro |
| `/today` | Today's events + reminders + tasks |
| `/briefing` | 🌅 Morning briefing — weather, quote, schedule |
| `/review` | 📊 Weekly review — notes, tasks, upcoming week |
| `/reflect` | 🧘 Daily reflection — patterns, changes, suggestions |
| `/reminders` | Upcoming reminders with `[❌ Cancel]` buttons |
| `/tasks` | 📋 All active tasks sorted by priority |
| `/goals` | 🎯 Goals with progress bars |
| `/notes` | Last 10 notes |
| `/memory` | All stored facts about you |
| `/people` | 👥 All remembered people & their relationships |
| `/person <name>` | 🔍 Search for a specific person |
| `/history <keyword>` | 🔍 Search past conversations |
| `/verify` | ⚠️ Review & resolve conflicting facts |
| `/plan` | **Fasa 4:** Active plans with steps + progress |
| `/domains` | **Fasa 3:** Memory organized by 8 domains |
| `/evaluate` | **Fasa 5:** Self-evaluation stats & learning |
| `/proactive` | **Fasa 5:** Trigger proactive suggestion |
| `/state` | **All Fasa:** Full bot state report |
| `/settings` | View bot name, personality, times, location |
| `/status` | API health (DeepSeek, MiMo, Whisper, Redis) |
| `/why` | 🧠 **State Machine:** Trace why bot responded that way |
| `/trace [N]` | 📊 **Observability:** Last N execution traces + latency |
| `/lifecycle` | 🔄 **Lifecycle:** Conversation phase + engagement |
| `/patterns` | 🔍 Detected behavioral patterns |
| `/patterns usage\|topic\|behavior\|trend\|correlation` | Filter by type |

### ⚙️ Settings

| Command | What it changes |
|---------|----------------|
| `/setname <name>` | Bot's display name |
| `/setpersonality <t>` | Bot's personality/tone |
| `/setlocation <city>` | Weather location |
| `/setbriefing <HH:MM>` | Morning briefing time |
| `/setreview <HH:MM>` | Weekly review time (Sunday) |
| `/revert` | Revert a setting to previous value |

---

## 🔬 9 Phase Upgrades

### Phase 1-3: Core Architecture (NOW)
| # | Upgrade | File | Function |
|---|---------|------|----------|
| 1 | **State Machine** | `executive/state-machine.js` | 8 explicit states, valid transitions, trace replay, `/why` |
| 7 | **Observability** | `utils/trace.js` | Spans, prompt/tool/memory logs, per-phase latency |
| 8 | **Fact Lock** | `llm/validator.js` | 3 tiers (verified/inferred/uncertain), assertion control |

### Phase 4-6: Memory & Engagement (SOON)
| # | Upgrade | File | Function |
|---|---------|------|----------|
| 6 | **Lifecycle** | `executive/lifecycle.js` | 5 phases, per-phase policies, dormant detection, `/lifecycle` |
| 2 | **Memory Strategy** | `memory/index.js` | Importance scoring, decay (λ per tier), compression, smart write |
| 3 | **Scenario Tests** | `test-scenarios.js` | 12 user journeys, 106 assertions, MockLLM |

### Phase 7-9: Optimization & Scale (LATER)
| # | Upgrade | File | Function |
|---|---------|------|----------|
| 5 | **Cost Optimizer** | `llm/index.js` | Token estimation, cost prediction, latency-aware routing |
| 9 | **Proactive Scoring** | `executive/proactive.js` | 4D opportunity engine (0-100), engagement tracking |
| 4 | **Tool Arbitration** | `tools/arbitration.js` | Conflict matrix, ranking, fallback chains, dependency resolution |

---

## 🛡️ Anti-Hallucination System

Multi-layer validator runs after every LLM response:

| Layer | What it catches |
|-------|----------------|
| **Action Detection** | "Done! Dah set reminder" without tool call |
| **Time Verification** | Wrong times (e.g., "6:36 am" when actual is 8:00 PM) |
| **Reminder Fabrication** | Fake reminder IDs/times — cross-references DB |
| **Fact Hallucination** | Made-up user facts not in memory |
| **Fact Lock** | ✅ verified → can assert / ⚠️ inferred → must hedge / ❓ uncertain → must question |
| **Fallback** | Auto-replaces bad responses with safe clarifying questions |

---

## 🧪 Testing

```bash
node test-max-capability.js   # 🔬 125 assertions — ALL features at max depth
node test-scenarios.js        # 🎭 106 assertions — 12 user journey simulations
node test-all-features.js     # 🧪 ~80 assertions — full feature coverage
node test-all-phases.js       # 🧪 ~50 assertions — all 5 Fasa modules
node test-executive.js        # Executive controller + intent engine
node test-perf-improvements.js # Performance & anti-hallucination validation
```

**Total: ~360+ assertions, zero API calls needed, all passing.**

---

## 🗂️ Project Structure

```
jarvis/
├── src/
│   ├── index.js                # Entry point — boots bot, API, scheduler
│   ├── bot/
│   │   └── index.js            # Telegram bot — all commands + message processing
│   ├── executive/              # 🧠 5-Fasa + 9 Upgrades
│   │   ├── index.js            # Controller — orchestrates all modules
│   │   ├── state-machine.js    # Phase 1: Explicit execution states + tracing
│   │   ├── lifecycle.js        # Phase 6: Conversation phase manager
│   │   ├── intent-engine.js    # Fasa 1: Advanced intent + mood + urgency
│   │   ├── working-memory.js   # Fasa 2: Brain scratchpad
│   │   ├── world-model.js      # Fasa 2: User state + domain awareness
│   │   ├── planner.js          # Fasa 4: Task decomposition + dependencies
│   │   ├── evaluator.js        # Fasa 5: Response quality scoring
│   │   └── proactive.js        # Fasa 5 + Phase 9: Opportunity-scored check-ins
│   ├── llm/
│   │   ├── index.js            # LLM Router + Phase 5: Cost/latency optimizer
│   │   ├── shared.js           # System prompt builder + Phase 8: Fact lock rules
│   │   ├── deepseek.js         # DeepSeek API provider (primary)
│   │   ├── mimo.js             # Xiaomi MiMo API provider (backup)
│   │   ├── intent.js           # Legacy fast keyword-based intent detection
│   │   ├── validator.js        # Anti-hallucination + Phase 8: Fact lock system
│   │   └── whisper.js          # OpenAI Whisper voice transcription
│   ├── memory/
│   │   ├── index.js            # RAG search + Phase 2: Write strategy + decay
│   │   ├── domains.js          # Fasa 3: 8 structured memory domains
│   │   └── relationships.js    # 👥 People memory — auto-extract + search
│   ├── tools/
│   │   ├── index.js            # 25+ tools + parameter validation
│   │   ├── arbitration.js      # Phase 4: Conflict, ranking, fallback, deps
│   │   ├── quote.js            # Motivational quotes (ZenQuotes)
│   │   ├── search.js           # Web search via Tavily API
│   │   └── weather.js          # Weather fetcher (OpenWeatherMap)
│   ├── patterns/               # 🔍 Non-LLM pattern recognition
│   │   ├── index.js            # Core: tracking, full/incremental analysis
│   │   ├── shared.js           # Keyword extraction, math utils
│   │   └── detectors/          # usage.js, topics.js, behavior.js, trends.js
│   ├── scheduler/
│   │   └── index.js            # Cron: reminders + briefing + review + patterns
│   ├── api/
│   │   ├── index.js            # REST API server (Express)
│   │   └── status.js           # API health check formatter
│   ├── redis/
│   │   └── index.js            # Redis cache layer (optional)
│   ├── db/
│   │   └── index.js            # All PostgreSQL queries
│   └── utils/
│       ├── datetime.js         # Date/time helpers (dayjs)
│       └── trace.js            # Phase 7: Observability (spans, logs, latency)
├── scripts/
│   └── setup-db.js             # One-time DB table creation
├── test-max-capability.js      # 🔬 125 assertions — ultimate stress test
├── test-scenarios.js           # 🎭 106 assertions — 12 user journeys
├── test-all-features.js        # 🧪 Full feature coverage
├── test-all-phases.js          # 🧪 All 5 Fasa modules
├── test-executive.js           # Executive controller tests
├── test-perf-improvements.js   # Performance validation
├── TESTING-GUIDE.md            # Step-by-step testing guide
├── ANTI-HALLUCINATION-IMPROVEMENTS.md
├── CHANGES-SUMMARY.md
├── .env.example
├── package.json
└── README.md
```

---

## 🚀 Setup

### Requirements
- Node.js **v18+**
- PostgreSQL **v14+**
- Telegram Bot Token ([@BotFather](https://t.me/botfather))
- DeepSeek API key ([platform.deepseek.com](https://platform.deepseek.com))
- Your Telegram user ID ([@userinfobot](https://t.me/userinfobot))
- _(Optional)_ Redis, MiMo API, OpenAI (Whisper), Tavily (search), OpenWeatherMap

### Quick Start

```bash
git clone <repo> jarvis && cd jarvis
npm install
cp .env.example .env
nano .env   # Fill in required keys
npm run setup-db
npm start
```

### VPS (keep running forever)

```bash
npm install -g pm2
pm2 start src/index.js --name jarvis
pm2 save && pm2 startup
```

---

## 📝 Available LLM Tools (25+)

| Category | Tools |
|----------|-------|
| **Reminders** | `create_reminder`, `update_reminder`, `cancel_reminder`, `list_reminders` |
| **Events** | `create_event`, `update_event`, `cancel_event` |
| **Notes** | `add_note` |
| **Facts** | `set_fact` |
| **Tasks** | `create_task`, `update_task`, `start_task`, `complete_task`, `cancel_task`, `list_tasks` |
| **Goals** | `create_goal`, `update_goal`, `complete_goal`, `abandon_goal`, `list_goals` |
| **People** | `save_relationship`, `list_people` |
| **Search** | `web_search` |
| **Time** | `get_current_time`, `get_today`, `get_briefing`, `get_weekly_review` |
| **Other** | `get_quote`, `set_config`, `revert_config` |

---

## 🔘 Inline Buttons

| Context | Buttons |
|---------|---------|
| Reminder created/updated | `[✏️ Edit]` `[❌ Cancel]` |
| Event created/updated | `[✏️ Edit]` `[❌ Cancel]` |
| Note saved | `[❌ Delete]` |
| Fact remembered | `[❌ Forget]` |
| Task created | `[🚀 Start]` `[✅ Done]` `[❌ Cancel]` |
| Goal set | `[🏆 Complete]` `[🗑️ Abandon]` |
| Reminder fires | `[✅ Done]` `[🔁 Snooze 10m]` |
| Settings change | `[✅ Ya]` `[❌ Batal]` |
| Conflict detected | `[✅ Keep]` `[↩️ Restore]` |

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| "Missing required environment variables" | `.env` missing or incomplete |
| "password authentication failed" | Check `DATABASE_URL` credentials |
| Voice not working | Set `OPENAI_API_KEY` in `.env` |
| Bot not responding | Check `TELEGRAM_OWNER_ID` is numeric ID |
| Reminders wrong time | Check `TIMEZONE` in `.env` |
| DeepSeek API error | Check credits at platform.deepseek.com |
| "Redis unavailable" | Not an error — optional, bot works without |
| "⚠️ Hallucination detected" | **Good!** Validator caught it before sending |
| "⏰ Fixing hallucinated time" | Time guard auto-corrected LLM time |
| "All LLM providers unavailable" | Both DeepSeek AND MiMo down — check API keys |

---

## 🌐 REST API (optional)

| Endpoint | Description |
|----------|-------------|
| `GET /` | API info — name, version, routes |
| `GET /health` | Health check — status + uptime |
| `GET /today` | Today's events and reminders (JSON) |
| `GET /memory` | All stored data — facts, events, notes |
| `POST /notes` | Add a note `{"content":"..."}` |
