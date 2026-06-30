# Anti-Hallucination Improvements - Summary

## Latest Update (29 Jun 2026): Reminder Time Fabrication Fix

### Problem Fixed

The bot was **fabricating reminder times** in message responses. For example:

- ❌ "#4 - Netherlands vs Morocco — pukul 6:36 am" when actual time was 8:00 PM
- ❌ "#5 - Makan malam — pukul 6:36 pm" when actual time was 8:00 PM
- ❌ Bot would say "pukul 6:38 pm" when corrected, still wrong

### Root Cause

The LLM was mentioning reminders with fabricated IDs and times in plain `message` type responses (instead of calling the `list_reminders` tool). The existing `fixHallucinatedTime()` only checked against **current time**, not against **stored reminder times** in the database.

### Solutions Implemented (v2)

#### 1. **Reminder Fabrication Detection** (`src/llm/validator.js`)

- New `detectReminderFabrication()` function cross-references mentioned reminder IDs/times with actual DB records
- Catches: wrong times, wrong text, nonexistent IDs
- When detected → forces `list_reminders` tool call to get accurate data

#### 2. **Enhanced Fake List Detection** (`src/bot/index.js`)

- Expanded regex to catch more hallucinated reminder list formats
- Now detects: `#4 - Text — pukul X:XX`, multiple `#ID` mentions, numbered lists
- Automatically replaces with `list_reminders` tool call

#### 3. **Stronger System Prompt Rules** (`src/llm/shared.js`)

- Added explicit anti-fabrication section with examples of WRONG vs CORRECT
- "6:36 is almost never a real reminder time — users set round times like 6:00, 8:00"
- "If two reminders have the same fabricated time, you are 100% hallucinating"
- Reminder times in the list are already correct AM/PM — don't change them

#### 4. **Force Tool Call on Fabrication** (`src/llm/deepseek.js`, `src/llm/mimo.js`)

- When reminder fabrication detected → returns `list_reminders` tool call instead of message
- Ensures user always sees accurate, DB-verified times

#### 5. **Improved Fallback Logic** (`src/llm/validator.js`)

- `generateFallbackResponse()` now recognizes reminder-related queries
- Triggers proper tool call chain for accurate results

## Previous Solutions (v1)

### 1. **Response Validation Layer** (`src/llm/validator.js`)

Created a comprehensive validator that detects and prevents hallucinations:

- **Action Hallucination Detection**: Catches when the LLM claims to have done something (using words like "created", "saved", "dah set", etc.) without actually calling a tool
- **Time Hallucination Detection**: Validates that any time mentioned matches the actual current time (within 2 minutes)
- **Fact Hallucination Detection**: Checks if the bot is making up facts about the user that aren't in its memory
- **Safe Fallback Responses**: When hallucination is detected, returns a clarifying question instead

### 2. **Enhanced System Prompt** (`src/llm/shared.js`)

Strengthened the instructions to the LLM with:

- **Stricter Action Awareness**: Explicitly states the bot has ZERO ability to perform actions and must use tool calls
- **Forbidden Words List**: Clearly lists words that should NEVER appear in message responses (like "done", "created", "dah set")
- **Time Accuracy Rules**: Emphasizes using EXACT times from context, never rounding or guessing
- **Memory Awareness**: Instructs the bot to only reference facts explicitly in its memory
- **Reminder Awareness**: Teaches the bot to check the reminder list and not make up reminder IDs

### 3. **Integrated Validation** (`src/llm/deepseek.js`, `src/llm/mimo.js`)

Added validation to both LLM providers:

- Every response is checked before being sent to the user
- Hallucinated action claims are caught and replaced with safe clarifying questions
- Validation issues are logged for debugging

### 4. **Improved Memory Search** (`src/memory/index.js`)

Enhanced fact relevance scoring for better context retrieval:

- **Stop Words Filtering**: Removes common words that don't add meaning
- **Exact Match Scoring**: Prioritizes facts where query words match exactly
- **Category Matching**: Groups related concepts (schedule, work, personal, etc.)
- **Importance Weighting**: Frequently accessed facts score higher
- **Question Detection**: When user asks a question, prioritizes facts that might answer it

This means the LLM gets more relevant context, reducing the chance it makes up information.

### 5. **Tool Call Parameter Validation** (`src/tools/index.js`)

Added schema-based validation for all tool calls:

- **Schema Definitions**: Each tool has defined required and optional parameters
- **Pre-Execution Validation**: Tool calls are validated before execution
- **Clear Error Messages**: Users get helpful feedback if something is missing
- **Type Checking**: Validates IDs are numbers and positive

### 6. **Existing Time Guard Enhanced**

The existing `fixHallucinatedTime()` function in `src/bot/index.js` already catches time hallucinations. With our new validator, we have two layers of protection.

## How This Fixes Your Bot

### Before:

❌ **User**: "Remind me at 6pm"  
❌ **Bot**: "Done! Dah set reminder pukul 6pm" (didn't actually create it)

### After:

✅ **User**: "Remind me at 6pm"  
✅ **Bot**: [Calls create_reminder tool]  
✅ **System**: "✅ Reminder set! 📅 Monday, 30 Jun 2026 🕐 6:00 PM"

### Before:

❌ **User**: "What time is it?"  
❌ **Bot**: "It's 7:15 PM" (but it's actually 6:40 PM)

### After:

✅ **User**: "What time is it?"  
✅ **Bot**: [Calls get_current_time tool OR states exact time from context]  
✅ **Bot**: "It's 6:40 PM"

### Before:

❌ **User**: "Cancel my gym reminder"  
❌ **Bot**: "Dah cancel!" (but there was no gym reminder)

### After:

✅ **User**: "Cancel my gym reminder"  
✅ **Bot**: "I don't see a gym reminder in your list. You have: [lists actual reminders]"

## Testing Recommendations

Test these scenarios to verify the fixes:

1. **Action Claims**: Say "remind me to exercise" and verify the bot calls create_reminder, not just says "done"
2. **Time Accuracy**: Ask "what time is it" and verify the response matches actual time
3. **Non-existent Reminders**: Try to cancel a reminder that doesn't exist
4. **Memory Facts**: Ask about something the bot doesn't know about you - it should say it doesn't have that info
5. **Missing Parameters**: Try vague requests like "remind me" (no time) - bot should ask for details

## Key Benefits

1. **Accuracy**: Bot only claims to do things it actually does
2. **Reliability**: Time references are always accurate
3. **Honesty**: Bot admits when it doesn't know something
4. **Intelligence**: Better context retrieval means more relevant responses
5. **Safety**: Multiple validation layers catch issues before they reach users

## Architecture Overview

```
User Message
    ↓
[Bot receives message]
    ↓
[LLM processes with enhanced prompt]
    ↓
[Response Validator checks for hallucinations]
    ↓
    ├─ Hallucination detected → Return safe fallback
    └─ Valid response → Continue
        ↓
        ├─ Message type → Send to user
        └─ Tool call → Validate parameters → Execute → Send result
```

## Logging

All validation issues are logged to console:

- `[DeepSeek] ⚠️ Hallucination detected: ...`
- `[Tools] ❌ Validation failed: ...`
- `[Bot] ⏰ Fixing hallucinated time: ...`

Check your logs to see how many hallucinations are being caught and prevented.

## Configuration

No configuration needed - all improvements work automatically. The validator uses your existing `TIMEZONE` env variable for time validation.

---

**Your bot is now significantly more intelligent and reliable!** 🎉
