# 🎮 Jarvis Bot — Interactive Features Record

> Last updated: **2026-07-10**

---

## ✅ Selesai

### 1. Inline Keyboard (Butang Interaktif) — `2026-07-10`

**Fail terlibat:**

| Fail                   | Jenis   | Penerangan                                                                                                                                                     |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bot/keyboards.js` | ✨ Baru | Module helper untuk bina inline keyboard, 14 jenis keyboard siap-pakai                                                                                         |
| `src/bot/index.js`     | 🔧 Ubah | Integrasi keyboard ke `/start`, `/help`, `/today`, `/briefing`, `/streak`, `/notes`, `/review`, `/quote`, `/settings`, semua response message & tool execution |
| `src/tools/index.js`   | 🔧 Ubah | Update `safeSendMessage()` & `sendSingleMessage()` support `extraOptions` parameter untuk keyboard                                                             |

**Keyboard yang tersedia:**

| Keyboard                  | Situasi                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `welcomeMenu()`           | `/start` — Set Reminder, Write Note, Today, Briefing, Help, Settings             |
| `helpMenu()`              | `/help` — Semua command dalam 4 baris butang berkumpulan                         |
| `quickActions()`          | Setiap response chat & tool — Today, Reminders, Notes, Briefing, Streak, Reflect |
| `afterStreak()`           | `/streak` — Chat More, Do Task, Briefing, Reflect                                |
| `settingsMenu()`          | `/settings` — Bot Name, Personality, Location, Briefing Time, View, Revert       |
| `afterReflection()`       | `/reflect` — Create Task, Set Goal, Plan Tomorrow                                |
| `afterWeekly()`           | `/review` — Set Goal, Plan Week, Full Report                                     |
| `afterCreateReminder(id)` | Lepas create reminder — Edit, Cancel, List, Today                                |
| `afterCreateEvent(id)`    | Lepas create event — Edit, Cancel, List, Add More                                |
| `afterCreateTask(id)`     | Lepas create task — Done, Cancel, All Tasks, Add More                            |
| `afterCancel(id, type)`   | Lepas cancel item — List, Today                                                  |
| `confirmDelete(type, id)` | Confirm delete dialog — Ya Padam / Batal                                         |
| `emptyState(type)`        | Bila list kosong — Butang create item spesifik                                   |
| `taskActions(tasks)`      | List task — Complete button untuk setiap task                                    |
| `custom(rows)`            | Dynamic builder untuk custom keyboard                                            |
| `row(buttons)`            | Single-row shortcut                                                              |

**Callback handlers baru:**

| Prefix             | Bil. | Penerangan                                                                                                                                                                                                               |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cmd:*`            | 14   | Execute command via button (`today`, `briefing`, `reminders`, `tasks`, `goals`, `notes`, `memory`, `people`, `reflect`, `streak`, `status`, `settings`, `help`, `start`)                                                 |
| `action:*`         | 15   | Prompt user input (`add_reminder`, `add_task`, `add_goal`, `add_note`, `add_event`, `set_fact`, `add_person`, `setname`, `setpersonality`, `setlocation`, `setbriefing`, `revert`, `chat`, `plan_tomorrow`, `plan_week`) |
| `confirm_delete:*` | 4    | Delete items (reminder, event, note, task)                                                                                                                                                                               |
| `cancel_action`    | 1    | Dismiss confirm dialog                                                                                                                                                                                                   |

---

## ⭕ Belum Mula

### 2. ⏱️ Interactive Pomodoro / Focus Timer — ⭐⭐⭐

- User taip "focus 25 minit" → bot hantar countdown message yang update secara live
- Butang **Selesai**, **Rehat**, **Extend +5 min**
- Track session focus dalam daily stats

### 3. 📊 Mood Tracker Harian — ⭐⭐⭐

- Setiap hari bot tanya "Macam mana mood hari ni? 😊 😐 😢"
- User tekan emoji button → simpan ke DB
- Weekly/Monthly mood chart yang dijana secara visual

### 4. 🏆 Gamification XP & Badges — ⭐⭐

- **XP Points & Level** — setiap interaksi dapat XP, level up dapat badge
- **Daily Challenges** — misi rawak setiap hari ("Tambah 3 task hari ini")
- **Achievement Badges** — "Early Bird 🌅", "Task Master ✅", "7-Day Streak 🔥"

### 5. 📝 Interactive Journaling / Refleksi — ⭐⭐

- Bot tanya soalan refleksi secara berstruktur (satu per satu)
- User jawab step-by-step → bot compile jadi journal entry
- Contoh: "Apa yang paling bermakna hari ini?" → tunggu jawapan → "Apa yang boleh improve esok?"

### 6. 🗳️ Quick Polls / Undian Pantas — ⭐

- User boleh buat quick poll untuk keputusan: "Nak makan mana: 🍕 Pizza atau 🍣 Sushi?"
- Bot parse dan hantar poll dengan butang inline

### 7. 💰 Expense Tracker Pantas — ⭐⭐

- Taip "belanja RM12.50 lunch" → auto-log ke DB
- Butang **Lihat spending minggu ini** → hantar summary
- Kategori auto-detect (food, transport, shopping)

### 8. 📚 Flashcard / Quiz Mode — ⭐

- User create flashcard via chat
- Bot quiz user secara interaktif dengan butang jawapan
- Track skor dan progress pembelajaran

### 9. 🎲 Decision Helper / Randomizer — ⭐

- "Jarvis, tolong decide antara A, B, C"
- Bot reply dengan spinning animation (edit message) → reveal result
- Coin flip, dadu, random pick dari list

### 10. 🔔 Reaction-based Interactions — ⭐

- Bot hantar message → user react dengan emoji → bot respond
- Contoh: Bot tanya "Confirm nak delete task ini?" → user react 👍 → auto delete

### 11. 📍 Location-based Quick Actions — ⭐

- User share location → bot suggest nearby: prayer times, weather, places
- Butang untuk simpan lokasi sebagai "Rumah", "Office", "Gym"

### 12. 🧩 Interactive Workflows (Step-by-Step Wizard) — ⭐⭐

- Bila user taip "plan trip", bot guide step-by-step:
  1. Mana destinasi?
  2. Bila nak pergi?
  3. Budget berapa?
- Auto-create reminders, checklist, dan itinerary

### 13. 🎨 Visual Progress Bars — ⭐

- Untuk goals dan habits, hantar progress bar yang update live
- Contoh: `[████████░░] 80% — 4/5 habits complete today`

### 14. 📸 Photo/Media Journal — ⭐

- User hantar gambar → bot simpan dengan caption/note
- Boleh query balik: "Show me photos from last week"
- Auto-tag berdasarkan vision analysis

### 15. 🔗 Integration Quick Actions — ⭐

- Generate shareable link untuk task/reminder
- Export daily summary sebagai gambar/sticker
- Quick share ke Google Calendar (future)
