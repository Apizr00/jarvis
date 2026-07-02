# Plugins Directory

Drop plugin folders here to extend Jarvis. Each plugin needs a `plugin.json` manifest.

## Plugin Structure

```
plugins/
  my-plugin/
    plugin.json    — manifest (required)
    index.js       — entry point (required)
```

## plugin.json Example

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Does something cool",
  "author": "Your Name",
  "main": "index.js",
  "hooks": ["onInit", "onMessage", "onCommand"],
  "commands": ["/mycommand"],
  "capabilities": ["custom:action"],
  "config": {
    "enabled": true
  }
}
```

## Available Hooks

- `onInit(ctx)` — called once when plugin loads
- `onEnable(ctx)` — called when plugin is enabled
- `onDisable(ctx)` — called when plugin is disabled
- `onUnload(ctx)` — called when plugin is removed
- `onMessage(ctx)` — called on every user message
- `onCommand(ctx)` — called for registered commands
- `onEvent(event, payload)` — called for all event bus events
- `onToolCall(toolName, args, ctx)` — intercept tool calls

## Context Object (ctx)

The context passed to hooks provides access to:

- `ctx.userId`, `ctx.message`, `ctx.bot` — current invocation data
- `ctx.llm` — LLM module for AI calls
- `ctx.db` — database access
- `ctx.eventBus` — emit/listen to events
- `ctx.agentRegistry` — register custom agents
- `ctx.tools` — access built-in tools
- `ctx.memory` — memory/facts storage
- `ctx.patterns` — pattern recognition
- `ctx.config` — plugin configuration
- `ctx.logger` — namespaced logger
- `ctx.registerCommand(cmd, handler)` — register a command
- `ctx.registerSchedule(cron, handler)` — register a cron job
- `ctx.registerAgent(agent)` — register a custom agent
