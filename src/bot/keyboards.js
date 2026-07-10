// src/bot/keyboards.js
// ── Inline Keyboard Builder ─────────────────────────────────────────────────
//
// Provides reusable inline keyboard layouts untuk bot Telegram.
// Semua keyboard direka untuk jadi compact & berguna.
//
// Usage:
//   const kb = require('./keyboards');
//   await bot.sendMessage(chatId, text, kb.withKeyboard({ inline_keyboard: kb.mainMenu() }));
//   // atau guna shorthand:
//   await bot.sendMessage(chatId, text, kb.mainMenu());
//   await bot.sendMessage(chatId, text, kb.quickActions());

const { escapeMd } = require('../tools');

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Wrap keyboard array dalam reply_markup object
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wrap an inline_keyboard array into a proper reply_markup object.
 * @param {Array<Array<object>>} keyboard
 * @returns {{reply_markup: {inline_keyboard: Array<Array<object>>}}}
 */
function wrap(keyboard) {
  return { reply_markup: { inline_keyboard: keyboard } };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MAIN MENU — Persistent quick-access buttons
// ═══════════════════════════════════════════════════════════════════════════════

function mainMenu() {
  return wrap([
    [
      { text: '📅 Today', callback_data: 'cmd:today' },
      { text: '🌅 Briefing', callback_data: 'cmd:briefing' },
    ],
    [
      { text: '⏰ Reminders', callback_data: 'cmd:reminders' },
      { text: '✅ Tasks', callback_data: 'cmd:tasks' },
    ],
    [
      { text: '📝 Notes', callback_data: 'cmd:notes' },
      { text: '🧠 Memory', callback_data: 'cmd:memory' },
    ],
    [
      { text: '🔥 Streak', callback_data: 'cmd:streak' },
      { text: '📊 Status', callback_data: 'cmd:status' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. QUICK ACTIONS — Appear after every bot response
// ═══════════════════════════════════════════════════════════════════════════════

function quickActions() {
  return wrap([
    [
      { text: '📅 Today', callback_data: 'cmd:today' },
      { text: '⏰ Reminders', callback_data: 'cmd:reminders' },
      { text: '📝 Notes', callback_data: 'cmd:notes' },
    ],
    [
      { text: '🌅 Briefing', callback_data: 'cmd:briefing' },
      { text: '🔥 Streak', callback_data: 'cmd:streak' },
      { text: '🧘 Reflect', callback_data: 'cmd:reflect' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. AFTER TOOL EXECUTION — Contextual actions after create/update/delete
// ═══════════════════════════════════════════════════════════════════════════════

function afterCreateReminder(reminderId) {
  return wrap([
    [
      { text: '✏️ Edit', callback_data: 'edit_reminder:' + reminderId },
      { text: '❌ Cancel', callback_data: 'cancel_reminder:' + reminderId },
    ],
    [
      { text: '📋 List All', callback_data: 'cmd:reminders' },
      { text: '📅 Today', callback_data: 'cmd:today' },
    ],
  ]);
}

function afterCreateEvent(eventId) {
  return wrap([
    [
      { text: '✏️ Edit', callback_data: 'edit_event:' + eventId },
      { text: '❌ Cancel', callback_data: 'cancel_event:' + eventId },
    ],
    [
      { text: '📋 List Events', callback_data: 'cmd:today' },
      { text: '➕ Add More', callback_data: 'action:add_event' },
    ],
  ]);
}

function afterCreateTask(taskId) {
  return wrap([
    [
      { text: '✅ Done', callback_data: 'complete_task:' + taskId },
      { text: '❌ Cancel', callback_data: 'cancel_task:' + taskId },
    ],
    [
      { text: '📋 All Tasks', callback_data: 'cmd:tasks' },
      { text: '➕ Add More', callback_data: 'action:add_task' },
    ],
  ]);
}

function afterCancel(id, type) {
  return wrap([
    [
      { text: '📋 List ' + type + 's', callback_data: 'cmd:' + type + 's' },
      { text: '📅 Today', callback_data: 'cmd:today' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CONFIRMATION — Yes/No with context
// ═══════════════════════════════════════════════════════════════════════════════

function confirmDelete(itemType, itemId) {
  return wrap([
    [
      { text: '✅ Ya, Padam', callback_data: 'confirm_delete:' + itemType + ':' + itemId },
      { text: '❌ Batal', callback_data: 'cancel_action' },
    ],
  ]);
}

function confirmAction(action, data) {
  return wrap([
    [
      { text: '✅ Ya', callback_data: 'confirm:' + action + ':' + data },
      { text: '❌ Tidak', callback_data: 'cancel_action' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. SETTINGS — Configuration quick-access
// ═══════════════════════════════════════════════════════════════════════════════

function settingsMenu() {
  return wrap([
    [
      { text: '👤 Bot Name', callback_data: 'action:setname' },
      { text: '🎭 Personality', callback_data: 'action:setpersonality' },
    ],
    [
      { text: '📍 Location', callback_data: 'action:setlocation' },
      { text: '🌅 Briefing Time', callback_data: 'action:setbriefing' },
    ],
    [
      { text: '📋 View Settings', callback_data: 'cmd:settings' },
      { text: '↩️ Revert', callback_data: 'action:revert' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. REFLECTION — After /reflect
// ═══════════════════════════════════════════════════════════════════════════════

function afterReflection() {
  return wrap([
    [
      { text: '📝 Create Task', callback_data: 'action:add_task' },
      { text: '🎯 Set Goal', callback_data: 'action:add_goal' },
    ],
    [
      { text: '📅 Tomorrow Plan', callback_data: 'action:plan_tomorrow' },
      { text: '🏠 Main Menu', callback_data: 'cmd:start' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. HELP — Grouped by category
// ═══════════════════════════════════════════════════════════════════════════════

function helpMenu() {
  return wrap([
    [
      { text: '📅 Today', callback_data: 'cmd:today' },
      { text: '🌅 Briefing', callback_data: 'cmd:briefing' },
      { text: '⏰ Reminders', callback_data: 'cmd:reminders' },
    ],
    [
      { text: '✅ Tasks', callback_data: 'cmd:tasks' },
      { text: '🎯 Goals', callback_data: 'cmd:goals' },
      { text: '📝 Notes', callback_data: 'cmd:notes' },
    ],
    [
      { text: '🧠 Memory', callback_data: 'cmd:memory' },
      { text: '👥 People', callback_data: 'cmd:people' },
      { text: '🧘 Reflect', callback_data: 'cmd:reflect' },
    ],
    [
      { text: '🔥 Streak', callback_data: 'cmd:streak' },
      { text: '📊 Status', callback_data: 'cmd:status' },
      { text: '⚙️ Settings', callback_data: 'cmd:settings' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. STREAK — After viewing streaks
// ═══════════════════════════════════════════════════════════════════════════════

function afterStreak() {
  return wrap([
    [
      { text: '💬 Chat More', callback_data: 'action:chat' },
      { text: '✅ Do a Task', callback_data: 'cmd:tasks' },
    ],
    [
      { text: '🌅 Morning Briefing', callback_data: 'cmd:briefing' },
      { text: '🧘 Reflect', callback_data: 'cmd:reflect' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. WEEKLY — After weekly review
// ═══════════════════════════════════════════════════════════════════════════════

function afterWeekly() {
  return wrap([
    [
      { text: '🎯 Set New Goal', callback_data: 'action:add_goal' },
      { text: '📋 Plan Week', callback_data: 'action:plan_week' },
    ],
    [
      { text: '📊 Full Report', callback_data: 'cmd:state' },
      { text: '🏠 Main Menu', callback_data: 'cmd:start' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. EMPTY STATE — When a list is empty, provide quick action
// ═══════════════════════════════════════════════════════════════════════════════

function emptyState(type) {
  const actions = {
    reminders: { text: '➕ Create Reminder', cb: 'action:add_reminder' },
    tasks: { text: '➕ Add Task', cb: 'action:add_task' },
    notes: { text: '📝 Write Note', cb: 'action:add_note' },
    goals: { text: '🎯 Set Goal', cb: 'action:add_goal' },
    people: { text: '👤 Tell Me About Someone', cb: 'action:add_person' },
    memory: { text: '🧠 Remember Something', cb: 'action:set_fact' },
  };

  const action = actions[type];
  if (!action) return wrap([[{ text: '🏠 Main Menu', callback_data: 'cmd:start' }]]);

  return wrap([
    [action],
    [{ text: '🏠 Main Menu', callback_data: 'cmd:start' }],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. TASK LIST — Inline complete/cancel for each task (max 8 tasks)
// ═══════════════════════════════════════════════════════════════════════════════

function taskActions(tasks) {
  const buttons = [];
  for (const t of tasks.slice(0, 8)) {
    const label = (t.text || t.title || 'Task').slice(0, 25);
    buttons.push([
      { text: '✅ ' + label, callback_data: 'complete_task:' + t.id },
    ]);
  }
  buttons.push([
    { text: '➕ Add Task', callback_data: 'action:add_task' },
    { text: '🏠 Menu', callback_data: 'cmd:start' },
  ]);
  return wrap(buttons);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 12. DYNAMIC BUILDER — Build custom keyboard from array of {text, callback}
// ═══════════════════════════════════════════════════════════════════════════════

function custom(buttonRows) {
  const keyboard = buttonRows.map(row =>
    row.map(btn => ({
      text: btn.text,
      callback_data: btn.callback || btn.callback_data,
      url: btn.url || undefined,
    }))
  );
  return wrap(keyboard);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 13. SIMPLE ROW — Single row of buttons
// ═══════════════════════════════════════════════════════════════════════════════

function row(buttons) {
  return wrap([buttons.map(btn => ({
    text: btn.text,
    callback_data: btn.callback || btn.callback_data,
    url: btn.url || undefined,
  }))]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 14. WELCOME — Buttons for /start
// ═══════════════════════════════════════════════════════════════════════════════

function welcomeMenu() {
  return wrap([
    [
      { text: '📅 Today\'s Schedule', callback_data: 'cmd:today' },
      { text: '🌅 Morning Briefing', callback_data: 'cmd:briefing' },
    ],
    [
      { text: '⏰ Set Reminder', callback_data: 'action:add_reminder' },
      { text: '📝 Write Note', callback_data: 'action:add_note' },
    ],
    [
      { text: '❓ Help', callback_data: 'cmd:help' },
      { text: '⚙️ Settings', callback_data: 'cmd:settings' },
    ],
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  wrap,
  mainMenu,
  quickActions,
  afterCreateReminder,
  afterCreateEvent,
  afterCreateTask,
  afterCancel,
  confirmDelete,
  confirmAction,
  settingsMenu,
  afterReflection,
  helpMenu,
  afterStreak,
  afterWeekly,
  emptyState,
  taskActions,
  custom,
  row,
  welcomeMenu,
};
