# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin that automatically archives completed tasks as three-part summaries (Request → Decision → Acceptance) into `$HOME/.cai/projects/<sha1(cwd)>/history.md`. Recent history is injected into new sessions via SessionStart hook.

## Commands

```bash
./install -i    # Install plugin to Claude Code (rsync + marketplace register + plugin install)
./install -r    # Reinstall (uninstall then install) — REQUIRED after any source code change
./install -u    # Uninstall (preserves history data)
./install -s    # Check install status (read-only)
./install       # Show help (safe default, does nothing)
```

The source is rsync-copied to `~/.claude/plugins/marketplaces/claude-log-local/plugin/` — Claude Code requires real directories, not symlinks. Editing files here has no effect until `./install -r` is run.

## Architecture

### Two-Hook Flow

**SessionStart hook** (`scripts/session-start-hook.js`):
1. Computes `hash = sha1(cwd)`, ensures `$HOME/.cai/projects/<hash>/` exists with `path` file
2. Reads last N entries (default 10, within 10 days) and injects via `additionalContext` into session

**Stop hook** (`scripts/stop-hook.js`):
1. Reads transcript JSONL, extracts last assistant message text
2. Checks for "任务完成" trigger (end-anchored, with negation-word filtering)
3. If triggered: outputs `decision: "block"` with a `reason` that instructs Claude to write the entry
4. Claude resumes, reads the template from `templates/aitask-entry.md`, and appends to `history.md`
5. The hook itself never writes to `history.md` — it can't access conversation context

### Key Design Decisions

- **Hook doesn't write files**: Node.js scripts have no access to conversation context (tool calls, user intent, file changes). Claude writes the entry after being unblocked, producing higher-quality summaries.
- **Anti-loop**: `stop_hook_active` flag prevents re-triggering after the block-reason is executed. The reason instructs Claude not to say "任务完成" again.
- **End-anchored trigger**: `lastIndexOf` + regex ensures only the final occurrence counts, and only if followed by punctuation/whitespace. "任务完成了不少" won't trigger.
- **Negation filter**: 8-char window before the trigger phrase is checked for words like "避免", "不要", "禁止" — prevents meta-discussion from triggering.
- **Zero dependencies**: Only Node.js built-ins (fs, os, path, crypto). No npm install needed.

### File Layout

```
hooks/hooks.json              # Hook registration (SessionStart matcher: startup|resume|clear)
scripts/stop-hook.js          # Stop hook: trigger detection → block with reason
scripts/session-start-hook.js # SessionStart: archive setup + context injection
templates/aitask-entry.md     # Three-part entry template (TASK_ID, TITLE, REQUEST, DECISION, ACCEPTANCE)
commands/his.md               # /his slash command (reads history for current project)
skills/his/SKILL.md           # /his skill definition (same logic, richer instructions)
install                       # Bash install/uninstall/reinstall script
.claude-plugin/plugin.json    # Plugin manifest (name, version, description)
```

### Storage Layout

```
$HOME/.cai/projects/<sha1(cwd)>/
├── path          # Project absolute path (for reverse lookup)
└── history.md    # Append-only task archive
```

### Task ID Format

`YYYY-MM-DD-Txxx` where Txxx is a daily counter (T001–T999), auto-incremented by scanning existing entries.

### Configuration

Constants at the top of each script:
- `scripts/stop-hook.js`: `TRIGGER_PHRASE`, `NEGATION_TOKENS`, `NEGATION_WINDOW`, `PROJECT_ARCHIVE_ROOT`, `HISTORY_FILE`
- `scripts/session-start-hook.js`: `DEFAULT_RECENT_N` (10), `DEFAULT_RECENT_DAYS` (10), overridable via `CLAUDE_LOG_RECENT_N` / `CLAUDE_LOG_RECENT_DAYS` env vars

### macOS Compatibility

`sha1sum` is absent on macOS. Both hooks use Node's `crypto.createHash('sha1')`. The `/his` command and install script use `shasum -a 1` as fallback via shell.

### Hook Output Protocol

- **Continue**: `{"continue":true,"suppressOutput":true}` — no intervention
- **Block**: `{"decision":"block","reason":"..."}` — Claude resumes with reason as injected prompt
- **SessionStart with context**: `{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`
