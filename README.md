# 🤖 Jarvis — Personal AI Assistant for Telegram

A self-hosted AI assistant that lives in your Telegram. Talk naturally — reminders, calendar, notes, tasks, goals, web search, voice messages, and **proactive check-ins**. Powered by a **10-phase upgrade architecture** for intelligent, context-aware, observable, and safe responses.

**Stack:** Node.js · PostgreSQL · Redis · BullMQ · ILMU (YTL) + DeepSeek + MiMo · Telegram Bot API

**Extensible:** 📡 Event Bus · 🤖 Agent Layer · 🔌 Plugin System · 📮 Job Queue

## 🆕 v3.2 — What's New

- **📮 Job Queue System** — BullMQ + Redis: background tasks run async, bot responds **279ms faster** per message
- **🛡️ Fabricated Limitation Guard** — Detects & corrects LLM lies like "cannot access reminders" (retries with tool call)
- **⚡ Stream-First Response** — Removed "Analyzing…" placeholder; all tiers (fast/medium/deep) stream directly
- **📊 Queue Metrics** — `/queue` command shows live stats: jobs completed, actual time saved, throughput
- **🔬 Queue Benchmark** — `test-queue-benchmark.js` measures real before/after performance impact

## 🆕 v3.1 — What's New

- **💾 State Persistence** — Bot survives restarts! Working memory, plans, lifecycle saved to DB every 5 min
- **📊 5D Proactive Scoring** — Pattern signals from behavior detectors now influence proactive decisions
- **🔗 Smart Follow-Up Cascade** — After add_note → offers reminder; after complete_task → suggests next; 8 rule types
- **⏱️ Dynamic Timing** — Cooldowns adapt to bursty users (-30%) and active-task phases (+50%)
- **🎯 Adaptive Scoring** — Learns from response rates: <20% = penalty, >60% = boost, >10 responses = diminishing returns
- **👤 Personalized Messages** — Proactive messages include your name, current project, recent contacts
- **🇲🇾 Better BM Intent** — 3 new moods (bosan/grateful), negation handling ("tak sedih" ≠ sad)
- **🔍 Embedding Search** — Optional semantic memory search via DeepSeek embeddings (graceful fallback)
- **🤖 Agent Tool Routing** — Tool calls now route through agent layer for retry + event tracking
- **📁 Modular Bot** — `bot/index.js` split: anti-hallucination, history now separate modules

---

## 🧠 Architecture (5 Fasa + 9 Phase Upgrades)

```
User Message
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  � EVENT BUS — Pub/Sub Decoupling Layer                   │
│  24 namespaced events, middleware, async isolation        │
│  Plugins + agents subscribe without touching core         │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  🔌 PLUGIN SYSTEM — Extensible Architecture                │
│  onMessage · onCommand · onEvent · onToolCall hooks       │
│  Hot-reload, plugin.json manifest, isolated context       │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  �🔄 CONVERSATION LIFECYCLE MANAGER                        │
│  onboarding → idle → active_task → dormant → reactivation │
│  Phase-aware messaging policy + engagement tracking       │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  FASA 1: Executive + Intent Detection                     │
│  Mood, urgency, language, category detection              │
│  12 intent categories with confidence score               │
│  ⚡ TIER ROUTING: fast → ILMU / medium → MiMo / deep → DeepSeek │
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
│  📊 5D OPPORTUNITY SCORING: userState + timing +          │
│  pastBehavior + goalProximity + PATTERN SIGNALS → 0-100   │
│  🔗 CASCADE: auto-suggest next action after tool exec     │
│  🎯 ADAPTIVE: learns from response rates over time        │
│  👤 PERSONALIZED: name, project, contacts in messages     │
│  ⏱️  DYNAMIC: cooldowns adapt to user patterns & phase    │
└────────────────────┬─────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────┐
│  💾 STATE PERSISTENCE                                     │
│  Auto-save every 5 min: working memory, world model,     │
│  lifecycle, planner → bot_state DB table                  │
│  Survives restarts — no context amnesia                   │
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
         (ILMU / MiMo / DeepSeek with 💰 cost+latency optimizer)
```

---

## ✨ Highlights

- **📡 Event Bus** — Pub/sub system decoupling all components. 24 events, middleware, wildcard listeners, async isolation
- **🤖 Agent Layer** — 5 autonomous agents (Memory, Task, Reminder, Search, Weather) with retry, timeout, and validation
- **🔌 Plugin System** — Drop-in plugins with plugin.json manifest. 8 hook types, hot-reload, isolated context
- **🧠 5-Fasa Executive + 9 Phase Upgrades** — Production-grade architecture: state machine, observability, fact lock, lifecycle, memory strategy, cost optimizer, proactive scoring, tool arbitration
- **🔄 Conversation Lifecycle** — 5 phases (onboarding→idle→active_task→dormant→reactivation) with per-phase messaging policies
- **🧠 State Machine** — Explicit execution flow with `/why` command to trace every decision
- **📊 Observability Layer** — Execution spans, prompt/tool/memory logs, per-phase latency tracking
- **🔒 Fact Lock System** — 3-tier fact classification (verified/inferred/uncertain) controls LLM assertion confidence
- **💾 Memory Write Strategy** — Importance scoring, exponential decay, conflict resolution, old fact compression
- **🇲🇾 Multi-LLM Routing** — Tier-based: ILMU (fast BM) → MiMo (medium) → DeepSeek (deep). Auto-fallback with health tracking
- **📊 5D Proactive Opportunity Scoring** — userState + timing + pastBehavior + goalProximity + **patternSignals**
- **🔗 Smart Follow-Up Cascade** — Auto-suggests next action: add_note→reminder, complete_task→next task, web_search→save note
- **💾 State Persistence** — Bot survives restarts! Working memory, world model, plans auto-saved to DB
- **🎯 Adaptive Scoring** — Learns from response rates; diminishing returns after 10+ responses
- **👤 Personalized Proactive** — Messages include user name, current project, recent contacts
- **⏱️ Dynamic Cooldowns** — Adjusts timing: -30% for bursty users, +50% during active tasks
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

| Command                                                | Description                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `/start`                                               | Welcome message + feature intro                                        |
| `/today`                                               | Today's events + reminders + tasks                                     |
| `/briefing`                                            | 🌅 Morning briefing — weather, quote, schedule                         |
| `/review`                                              | 📊 Weekly review — notes, tasks, upcoming week                         |
| `/reflect`                                             | 🧘 Daily reflection — patterns, changes, suggestions                   |
| `/reminders`                                           | Upcoming reminders with `[❌ Cancel]` buttons                          |
| `/tasks`                                               | 📋 All active tasks sorted by priority                                 |
| `/goals`                                               | 🎯 Goals with progress bars                                            |
| `/notes`                                               | Last 10 notes                                                          |
| `/memory`                                              | All stored facts about you                                             |
| `/people`                                              | 👥 All remembered people & their relationships                         |
| `/person <name>`                                       | 🔍 Search for a specific person                                        |
| `/history <keyword>`                                   | 🔍 Search past conversations                                           |
| `/verify`                                              | ⚠️ Review & resolve conflicting facts                                  |
| `/plan`                                                | **Fasa 4:** Active plans with steps + progress                         |
| `/domains`                                             | **Fasa 3:** Memory organized by 8 domains                              |
| `/evaluate`                                            | **Fasa 5:** Self-evaluation stats & learning                           |
| `/proactive`                                           | **Fasa 5:** Trigger proactive suggestion                               |
| `/state`                                               | **All Fasa:** Full bot state report                                    |
| `/settings`                                            | View bot name, personality, times, location                            |
| `/status`                                              | API health (ILMU, DeepSeek, MiMo, Whisper, Redis)                      |
| `/why`                                                 | 🧠 **State Machine:** Trace why bot responded that way                 |
| `/trace [N]`                                           | 📊 **Observability:** Last N execution traces + latency                |
| `/lifecycle`                                           | 🔄 **Lifecycle:** Conversation phase + engagement                      |
| `/queue`                                               | 📮 **Queue System:** Jobs completed, actual time saved, throughput     |
| `/insights`                                            | 📊 **Plugin:** Usage stats, mood distribution, activity summary        |
| `/mood [mood]`                                         | 🎭 **Plugin:** Track mood, view 7-day mood trend                       |
| `/weekly`                                              | 📋 **Plugin:** Weekly summary — activity, productivity, mood breakdown |
| `/patterns`                                            | 🔍 Detected behavioral patterns                                        |
| `/patterns usage\|topic\|behavior\|trend\|correlation` | Filter by type                                                         |

### ⚙️ Settings

| Command                | What it changes                    |
| ---------------------- | ---------------------------------- |
| `/setname <name>`      | Bot's display name                 |
| `/setpersonality <t>`  | Bot's personality/tone             |
| `/setlocation <city>`  | Weather location                   |
| `/setbriefing <HH:MM>` | Morning briefing time              |
| `/setreview <HH:MM>`   | Weekly review time (Sunday)        |
| `/revert`              | Revert a setting to previous value |

---

## 🔬 10 Phase Upgrades

### Phase 1-3: Core Architecture ✅

| #   | Upgrade           | File                         | Function                                                   |
| --- | ----------------- | ---------------------------- | ---------------------------------------------------------- |
| 1   | **State Machine** | `executive/state-machine.js` | 8 explicit states, valid transitions, trace replay, `/why` |
| 7   | **Observability** | `utils/trace.js`             | Spans, prompt/tool/memory logs, per-phase latency          |
| 8   | **Fact Lock**     | `llm/validator.js`           | 3 tiers (verified/inferred/uncertain), assertion control   |

### Phase 4-6: Memory & Engagement ✅

| #   | Upgrade             | File                     | Function                                                         |
| --- | ------------------- | ------------------------ | ---------------------------------------------------------------- |
| 6   | **Lifecycle**       | `executive/lifecycle.js` | 5 phases, per-phase policies, dormant detection, `/lifecycle`    |
| 2   | **Memory Strategy** | `memory/index.js`        | Importance scoring, decay (λ per tier), compression, smart write |
| 3   | **Scenario Tests**  | `test-scenarios.js`      | 12 user journeys, 106 assertions, MockLLM                        |

### Phase 7-9: Optimization & Scale ✅

| #   | Upgrade               | File                     | Function                                                         |
| --- | --------------------- | ------------------------ | ---------------------------------------------------------------- |
| 5   | **Cost Optimizer**    | `llm/index.js`           | Token estimation, cost prediction, latency-aware routing         |
| 9   | **Proactive Scoring** | `executive/proactive.js` | **5D** engine (0-100): +pattern signals, adaptive, personalized  |
| 4   | **Tool Arbitration**  | `tools/arbitration.js`   | Conflict matrix, ranking, fallback chains, dependency resolution |

### Phase 10: Proactivity & Persistence (v3.1) 🆕

| #   | Upgrade                | File                         | Function                                                       |
| --- | ---------------------- | ---------------------------- | -------------------------------------------------------------- |
| 10a | **Pattern→Proactive**  | `executive/proactive.js`     | Pattern signals feed into 5D opportunity scoring               |
| 10b | **State Persistence**  | `executive/persistence.js`   | Auto-save/load runtime state every 5 min; survive restarts     |
| 10c | **Bot Modularization** | `bot/anti-hallucination.js`  | Split 2635-line bot into separate modules                      |
| 10d | **Follow-Up Cascade**  | `executive/cascade.js`       | 8 configurable cascade rules: note→reminder, task→next, etc.   |
| 10e | **Adaptive + Dynamic** | `executive/proactive.js`     | Scoring learns from rates; cooldowns adapt to user patterns    |
| 10f | **Agent Tool Routing** | `agents/index.js`            | `dispatchToolCall()` routes tools through agent retry layer    |
| 10g | **Intent BM Enhance**  | `executive/intent-engine.js` | 3 new moods, negation handling, expanded BM keywords           |
| 10h | **Embedding Search**   | `memory/index.js`            | Optional DeepSeek embedding semantic search (keyword fallback) |

---

## 🛡️ Anti-Hallucination System

Multi-layer validator runs after every LLM response:

| Layer                         | What it catches                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| **Action Detection**          | "Done! Dah set reminder" without tool call                                         |
| **Fabricated Limitations** 🆕 | "Cannot access reminders" / "Tak dapat akses" — retries with tool call             |
| **Reminder List Fabrication** | LLM invents reminder list instead of calling `list_reminders`                      |
| **Search Acknowledgment**     | "Kejap, aku search dulu" but never calls `web_search`                              |
| **Time Verification**         | Wrong times (e.g., "6:36 am" when actual is 8:00 PM)                               |
| **Greeting Correction**       | "Selamat pagi" at 8pm → "Selamat malam"                                            |
| **Fact Hallucination**        | Made-up user facts not in memory                                                   |
| **Fact Lock**                 | ✅ verified → can assert / ⚠️ inferred → must hedge / ❓ uncertain → must question |
| **Fallback**                  | Auto-replaces bad responses with safe clarifying questions                         |

---

## 🧪 Testing

```bash
node test-max-capability.js   # 🔬 125 assertions — ALL features at max depth
node test-scenarios.js        # 🎭 106 assertions — 12 user journey simulations
node test-all-features.js     # 🧪 67 assertions — full feature coverage
node test-all-phases.js       # 🧪 46 assertions — all 5 Fasa modules
node test-queue-benchmark.js  # 📮 Queue before/after — measures real time saved
node test-executive.js        # Executive controller + intent engine
node test-perf-improvements.js # Performance & anti-hallucination validation
```

**Total: ~360+ assertions, zero API calls needed, all passing.**

---

## 🗂️ Project Structure

```
jarvis/
├── src/
│   ├── index.js                # Entry point — boots event bus, agents, plugins, bot, API, scheduler
│   ├── events/
│   │   └── index.js            # 📡 Event Bus — pub/sub, 24 events, middleware, async isolation
│   ├── agents/
│   │   └── index.js            # 🤖 Agent Layer — 5 autonomous agents + AgentRegistry
│   ├── plugins/
│   │   ├── index.js            # 🔌 Plugin System — discovery, lifecycle, 8 hook types
│   │   └── builtin/
│   │       └── jarvis-insights/ # Built-in plugin: /insights, /mood, /weekly
│   ├── bot/
│   │   ├── index.js            # Telegram bot — message processing + all commands
│   │   ├── anti-hallucination.js # 🛡️ Greeting + time hallucination guards
│   │   └── history.js          # 💬 Conversation history, summarization, dedup
│   ├── executive/              # 🧠 5-Fasa + 10 Upgrades
│   │   ├── index.js            # Controller — orchestrates all modules
│   │   ├── state-machine.js    # Phase 1: Explicit execution states + tracing
│   │   ├── lifecycle.js        # Phase 6: Conversation phase manager
│   │   ├── intent-engine.js    # Fasa 1: Advanced intent + mood + urgency + negation
│   │   ├── working-memory.js   # Fasa 2: Brain scratchpad (+ persistence)
│   │   ├── world-model.js      # Fasa 2: User state + domain awareness (+ persistence)
│   │   ├── planner.js          # Fasa 4: Task decomposition + dependencies (+ persistence)
│   │   ├── evaluator.js        # Fasa 5: Response quality scoring
│   │   ├── proactive.js        # Fasa 5: 5D opportunity-scored check-ins
│   │   ├── cascade.js          # 🔗 Smart follow-up cascade rules (Phase 10)
│   │   └── persistence.js      # 💾 Auto-save/restore runtime state (Phase 10)
│   ├── llm/
│   │   ├── index.js            # LLM Router + Phase 5: Cost/latency optimizer
│   │   ├── shared.js           # System prompt builder + Phase 8: Fact lock rules
│   │   ├── ilmu.js             # ILMU by YTL AI Labs — Malaysia's sovereign AI (primary BM)
│   │   ├── deepseek.js         # DeepSeek API provider (primary deep reasoning)
│   │   ├── mimo.js             # Xiaomi MiMo API provider (backup/medium)
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
│   │   └── index.js            # Redis cache layer
│   ├── queue/
│   │   └── index.js            # 📮 Job Queue System — BullMQ workers, metrics, async offloading
│   ├── db/
│   │   └── index.js            # All PostgreSQL queries
│   └── utils/
│       ├── datetime.js         # Date/time helpers (dayjs)
│       └── trace.js            # Phase 7: Observability (spans, logs, latency)
├── plugins/
│   └── README.md               # Plugin developer documentation
├── scripts/
│   └── setup-db.js             # One-time DB table creation
├── test-queue-benchmark.js     # 📮 Queue before/after benchmark — real timing data
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

## � Event Bus

Decouples all components through a pub/sub system. Instead of direct function calls, modules communicate via namespaced events.

```
┌──────────┐  emit('tool:executed')  ┌──────────────┐  on('tool:executed')
│  Tools   │ ──────────────────────▶ │  Event Bus   │ ──────────────────▶ Plugins
└──────────┘                         │              │                     Agents
                                     │  Middleware  │                     Patterns
┌──────────┐  emit('message:sent')   │  Event Log   │                     Analytics
│   Bot    │ ──────────────────────▶ │  24 Events   │ ──────────────────▶ Monitor
└──────────┘                         └──────────────┘
```

**Core events:** `message:received`, `message:sent`, `tool:executed`, `tool:failed`, `intent:detected`, `state:changed`, `memory:updated`, `lifecycle:changed`, `error:occurred`, `plugin:loaded`, `agent:task_completed`, and 13 more.

**Features:** Async isolation (listener crashes don't affect emitters), per-listener timeouts, wildcard listeners (`*`), before/after middleware, event log for debugging.

---

## 🤖 Agent Layer

Autonomous task-execution units that sit **above** individual tools. While tools are single-purpose (`create_reminder`), agents orchestrate multi-step workflows with retry, validation, and error recovery.

| Agent             | Capabilities                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| **MemoryAgent**   | Auto-extract facts from chat, store/retrieve/update/forget facts, find relationships, summarize knowledge |
| **TaskAgent**     | Create, update, start, complete, cancel, list, prioritize tasks; link to goals                            |
| **ReminderAgent** | Create, update, cancel, list reminders; validate time formats with anti-hallucination guards              |
| **SearchAgent**   | Web search, news lookup, definition lookup with 15s timeout                                               |
| **WeatherAgent**  | Current weather, forecast, summary for configured location                                                |

Each agent has: exponential backoff retry (configurable), timeout protection, input validation, event bus integration, and status tracking (completed/failed counts, task history).

**Dispatch:** `agentRegistry.dispatch({ userId, action: 'memory:retrieve_context', params: { query: '...' } })` — automatically routes to the correct agent by namespace.

**Tool Routing (v3.1):** `agentRegistry.dispatchToolCall('create_reminder', args, userId)` — routes tool calls through agent layer first for retry + event tracking; falls back to direct execution if no agent matches.

---

## 💾 State Persistence (v3.1)

Bot now survives restarts without losing context. Every 5 minutes, critical runtime state is checkpointed to the `bot_state` database table:

| State          | What's Saved                                                |
| -------------- | ----------------------------------------------------------- |
| Working Memory | Current goal, problem, solutions, next steps, context notes |
| World Model    | Status, active domain, mood, interests, time patterns       |
| Lifecycle      | Current phase, phase history, message counts                |
| Planner        | Active plans with steps, dependencies, progress             |

**Flow:** Boot → `loadAll()` hydrates all modules → `setInterval(5 min)` auto-saves → `SIGTERM` final checkpoint.

---

## 🔗 Smart Follow-Up Cascade (v3.1)

After each tool execution, the cascade engine checks 8 configurable rules to suggest natural next actions:

| Trigger               | Suggestion                                     | Priority |
| --------------------- | ---------------------------------------------- | -------- |
| `add_note`            | "Nak saya setkan reminder untuk note ni?"      | 8        |
| `complete_task`       | "Next task: [title] — nak start?"              | 7        |
| `complete_task` (all) | "🏆 All done! Nak generate reflection?"        | 9        |
| `complete_goal`       | "🌟 Goal achieved! Next: [goal] — continue?"   | 9        |
| `web_search`          | "💡 Nak simpan hasil search sebagai note?"     | 5        |
| `create_reminder`     | "Nak buatkan preparation notes?" (events only) | 6        |
| `create_plan`         | "First step: [step] — nak set reminder?"       | 7        |
| User mentions problem | "Nak saya bantu pecahkan jadi action plan?"    | 6        |

Each rule has cooldown periods and conditional checks to avoid nagging.

---

## 🔍 Embedding Search (v3.1 — Optional)

When `DEEPSEEK_API_KEY` is configured, memory search can use semantic embeddings for better relevance matching — especially useful for BM/rojak queries where keyword matching is weak. Gracefully falls back to keyword search if embeddings fail or are unavailable.

---

## 🔌 Plugin System

Extend Jarvis without modifying core code. Drop a folder in `plugins/` with a `plugin.json` manifest and `index.js` entry point — auto-discovered on startup.

**plugin.json example:**

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Does something cool",
  "hooks": ["onInit", "onMessage", "onCommand"],
  "commands": ["/mycommand"],
  "capabilities": ["custom:action"]
}
```

**8 hook types:** `onInit`, `onEnable`, `onDisable`, `onUnload`, `onMessage`, `onCommand`, `onEvent`, `onToolCall`

**Plugin context** provides access to `llm`, `db`, `eventBus`, `agentRegistry`, `tools`, `memory`, `patterns` — plus `registerCommand()`, `registerSchedule()`, and `registerAgent()`.

**Built-in plugin:** `jarvis-insights` — provides `/insights` (usage stats), `/mood` (mood tracking + 7-day trend), and `/weekly` (productivity summary with mood breakdown).

**Lifecycle:** `discovered → loaded → initialized → enabled → disabled → unloaded` with hot-reload support.

---

## �🚀 Setup

### Requirements

- Node.js **v18+**
- PostgreSQL **v14+**
- Telegram Bot Token ([@BotFather](https://t.me/botfather))
- DeepSeek API key ([platform.deepseek.com](https://platform.deepseek.com))
- ILMU API key ([ilmu.ai](https://ilmu.ai)) — Malaysia's sovereign AI, best for BM
- Your Telegram user ID ([@userinfobot](https://t.me/userinfobot))
- _(Optional)_ MiMo API, OpenAI (Whisper), Tavily (search), OpenWeatherMap

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

| Category      | Tools                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| **Reminders** | `create_reminder`, `update_reminder`, `cancel_reminder`, `list_reminders`                |
| **Events**    | `create_event`, `update_event`, `cancel_event`                                           |
| **Notes**     | `add_note`                                                                               |
| **Facts**     | `set_fact`                                                                               |
| **Tasks**     | `create_task`, `update_task`, `start_task`, `complete_task`, `cancel_task`, `list_tasks` |
| **Goals**     | `create_goal`, `update_goal`, `complete_goal`, `abandon_goal`, `list_goals`              |
| **People**    | `save_relationship`, `list_people`                                                       |
| **Search**    | `web_search`                                                                             |
| **Time**      | `get_current_time`, `get_today`, `get_briefing`, `get_weekly_review`                     |
| **Other**     | `get_quote`, `set_config`, `revert_config`                                               |

---

## 🔘 Inline Buttons

| Context                  | Buttons                                |
| ------------------------ | -------------------------------------- |
| Reminder created/updated | `[✏️ Edit]` `[❌ Cancel]`              |
| Event created/updated    | `[✏️ Edit]` `[❌ Cancel]`              |
| Note saved               | `[❌ Delete]`                          |
| Fact remembered          | `[❌ Forget]`                          |
| Task created             | `[🚀 Start]` `[✅ Done]` `[❌ Cancel]` |
| Goal set                 | `[🏆 Complete]` `[🗑️ Abandon]`         |
| Reminder fires           | `[✅ Done]` `[🔁 Snooze 10m]`          |
| Settings change          | `[✅ Ya]` `[❌ Batal]`                 |
| Conflict detected        | `[✅ Keep]` `[↩️ Restore]`             |

---

## 🔧 Troubleshooting

| Problem                                  | Solution                                          |
| ---------------------------------------- | ------------------------------------------------- |
| "Missing required environment variables" | `.env` missing or incomplete                      |
| "password authentication failed"         | Check `DATABASE_URL` credentials                  |
| Voice not working                        | Set `OPENAI_API_KEY` in `.env`                    |
| Bot not responding                       | Check `TELEGRAM_OWNER_ID` is numeric ID           |
| Reminders wrong time                     | Check `TIMEZONE` in `.env`                        |
| DeepSeek API error                       | Check credits at platform.deepseek.com            |
| "Redis unavailable"                      | Not an error — optional, bot works without        |
| "⚠️ Hallucination detected"              | **Good!** Validator caught it before sending      |
| "⏰ Fixing hallucinated time"            | Time guard auto-corrected LLM time                |
| "All LLM providers unavailable"          | ILMU, DeepSeek AND MiMo all down — check API keys |

---

## 🌐 REST API (optional)

| Endpoint      | Description                            |
| ------------- | -------------------------------------- |
| `GET /`       | API info — name, version, routes       |
| `GET /health` | Health check — status + uptime         |
| `GET /today`  | Today's events and reminders (JSON)    |
| `GET /memory` | All stored data — facts, events, notes |
| `POST /notes` | Add a note `{"content":"..."}`         |
