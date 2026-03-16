# aimux

Native CLI agent multiplexer — run multiple AI coding tools side-by-side with their native TUIs intact.

aimux wraps tools like [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), and [Aider](https://github.com/paul-gauthier/aider) in PTY proxies, letting you switch between them like tmux panes while sharing context across agents.

## Features

- **Native TUI preservation** — each tool runs in its own PTY, keeping full color, scrollback, and interactivity
- **Leader key switching** — `Ctrl+A` prefix (like GNU screen/tmux) to switch between agents, open dashboard, create/kill sessions
- **Dashboard view** — see all running, offline, and remote agents at a glance
- **Multi-instance** — run aimux in multiple terminal tabs; agents from other instances appear inline and can be taken over
- **Agent lifecycle** — two-step kill (`[x]` stops → offline, `[x]` again → graveyard), with `aimux graveyard resurrect` for recovery
- **Task delegation** — agents can delegate work to each other via `.aimux/tasks/`, with automatic dispatch, completion notifications, and dashboard badges
- **Context sharing** — agents can read each other's conversation history via `.aimux/context/`
- **Session resume** — resume previous sessions using each tool's native resume (`--resume`) or injected history (`--restore`)
- **Git worktree support** — first-class worktree management for parallel feature work, with per-worktree agent isolation
- **Fully config-driven** — all tool behavior (prompt detection, session capture, resume, compaction) is declarative config, not code
- **Configurable** — global (`~/.aimux/config.json`) and project-level (`.aimux/config.json`) configuration with deep merge
- **Notifications** — cross-platform notifications (macOS, Linux, Windows) when agents need attention or complete tasks
- **Custom instructions** — `~/AIMUX.md` (global) and `./AIMUX.md` (project) are injected into every agent's preamble

## Install

```bash
# Clone and build
git clone https://github.com/TraderSamwise/aimux.git
cd aimux
yarn install
yarn build

# Link globally
yarn link
```

Requires Node.js >= 18.

## Quick Start

```bash
# Launch dashboard (shows active, offline, and remote agents)
aimux

# Launch a specific tool
aimux claude
aimux codex
aimux aider

# Resume all offline sessions
aimux --resume
```

## Hotkeys

All hotkeys use the `Ctrl+A` leader prefix:

| Key | Action |
|---|---|
| `Ctrl+A d` | Dashboard view |
| `Ctrl+A n` | Next agent |
| `Ctrl+A p` | Previous agent |
| `Ctrl+A c` | Create new agent |
| `Ctrl+A x` | Stop agent (→ offline) or kill offline agent (→ graveyard) |
| `Ctrl+A 1-9` | Focus agent by number |
| `Ctrl+A w` | Create new worktree |
| `Ctrl+A W` | Worktree management |
| `Ctrl+A Ctrl+A` | Send literal Ctrl+A |

## Dashboard

When you run `aimux` without arguments (or press `Ctrl+A d`), you get a dashboard showing all agents across all states:

```
         aimux — agent multiplexer
──────────────────────────────────────

  ● [1] claude — running ←
  ● [2] codex — idle
  ○ [3] claude — offline
  ◈ [4] claude — other tab (PID 54321)

──────────────────────────────────────
 ↑↓ select  Enter focus  [c] new  [x] stop  [q] quit
```

- **Enter** on a running agent focuses it
- **Enter** on an offline agent resumes it
- **Enter** on a remote agent (other tab) takes it over
- **`[x]`** on running → stops to offline; **`[x]`** on offline → sends to graveyard

With worktrees, agents are grouped:

```
   (main) — active
    ● [1] claude — running ←

   fix-auth (fix-auth) — active
    ● [2] claude — running
    ○ [3] codex — offline

──────────────────────────────────────
 ↑↓ worktrees  Enter step in  [c] new  [w] worktree  [q] quit
```

## Context System

aimux records each agent's conversation and makes it available to other agents:

- **`.aimux/context/{session-id}/live.md`** — rolling window of recent turns
- **`.aimux/context/{session-id}/summary.md`** — compacted history
- **`.aimux/history/{session-id}.jsonl`** — full raw conversation log
- **`.aimux/sessions.json`** — all running agents (so agents can discover each other)

Agents are told about these files in their startup preamble.

## Task Delegation

Agents can delegate work to each other through the aimux task system. This is a file-based protocol — agents create task files, aimux dispatches them, and agents report results.

### How it works

1. **Agent A** creates a task file in `.aimux/tasks/`:
   ```json
   {
     "id": "add-login-form",
     "status": "pending",
     "assignedBy": "claude-abc123",
     "description": "Add a login form component",
     "prompt": "Create a React login form at src/components/LoginForm.tsx with email and password fields, validation, and submit handler.",
     "createdAt": "2025-01-15T10:30:00Z",
     "updatedAt": "2025-01-15T10:30:00Z"
   }
   ```

2. **Aimux detects** the pending task (checks every 2s) and finds an idle agent to handle it

3. **The task prompt is injected** into the target agent's stdin — the agent sees it as input and starts working

4. **The agent completes the work** and updates the task file with `"status": "done"` and a `"result"` summary

5. **Aimux notifies** the original agent that the task is complete

### Targeting

Tasks can be targeted in three ways:

- **Specific agent**: set `assignedTo` to a session ID from `.aimux/sessions.json`
- **By tool type**: set `tool` to `"claude"`, `"codex"`, or `"aider"` — dispatched to the first idle agent of that type
- **Any idle agent**: omit both fields — dispatched to any available idle agent

### Dashboard indicators

- Sessions with active tasks show a purple `⧫` badge with the task description
- The footer shows task counts: `[T:2p/1a]` (2 pending, 1 assigned)
- Flash notifications appear when tasks are assigned, completed, or failed

### Using it

Just ask your agent to delegate. The preamble tells agents exactly how the protocol works. For example:

> "Delegate the test writing to another agent"

> "Hand off the CSS cleanup to the codex agent"

The agent will create the task file, and aimux handles the rest. This is separate from any native task system in the underlying tools (like Claude Code's internal tasks).

## Custom Instructions

Create an `AIMUX.md` file to inject instructions into every agent:

- **`~/AIMUX.md`** — global instructions (applied to all projects)
- **`./AIMUX.md`** — project-specific instructions

Both are read and appended to the preamble (global first, then project).

## Configuration

Initialize project config:

```bash
aimux init
```

This creates `.aimux/config.json`. You can also create a global config at `~/.aimux/config.json`. Project config overrides global, which overrides defaults.

```json
{
  "defaultTool": "claude",
  "notifications": {
    "enabled": true,
    "onPrompt": true,
    "onError": true,
    "onComplete": true
  },
  "tools": {
    "claude": {
      "command": "claude",
      "args": ["--dangerously-skip-permissions"],
      "enabled": true
    }
  }
}
```

### Tool Configuration

All tool behavior is config-driven. No tool-specific code exists in the multiplexer — adding or customizing a tool only requires config:

```json
{
  "tools": {
    "my-tool": {
      "command": "my-tool",
      "args": ["--some-flag"],
      "enabled": true,
      "preambleFlag": ["--system-prompt"],
      "resumeArgs": ["--resume", "{sessionId}"],
      "resumeFallback": ["--continue"],
      "sessionIdFlag": ["--session-id", "{sessionId}"],
      "sessionCapture": {
        "dir": "{home}/.my-tool/sessions/{yyyy}/{mm}/{dd}",
        "pattern": "([0-9a-f-]+)\\.json$",
        "delayMs": 2000
      },
      "promptPatterns": ["^> $", "^\\$ $"],
      "turnPatterns": ["^[>❯]\\s*(.+)"],
      "compactCommand": "claude --print --output-format text",
      "instructionsFile": "AGENTS.md"
    }
  }
}
```

| Field | Purpose |
|---|---|
| `preambleFlag` | Flag to inject system prompt (e.g. `["--append-system-prompt"]`) |
| `resumeArgs` | Args to resume a session, with `{sessionId}` placeholder |
| `resumeFallback` | Fallback resume args when session ID is unavailable |
| `sessionIdFlag` | Flag to set session ID at spawn time |
| `sessionCapture` | Filesystem-based session ID capture (dir, regex pattern, delay) |
| `promptPatterns` | Regex patterns for idle/prompt detection in status bar |
| `turnPatterns` | Regex patterns for extracting conversation turns from output |
| `compactCommand` | Shell command for LLM-powered history compaction |
| `instructionsFile` | File to write preamble to (for tools without system prompt flags) |

## Multi-Instance

Run aimux in multiple terminal tabs for the same project. Each instance registers in `.aimux/instances.json` with a heartbeat. Agents from other instances appear inline in the dashboard with a `◈` icon.

- **Enter** on a remote agent takes it over (resumes in your instance)
- `--resume` skips agents already owned by another live instance
- When an instance exits, its agents become offline and visible to other instances
- Dead instances are auto-pruned via PID checks and heartbeat staleness

## Agent Lifecycle

Agents have three states: **running**, **offline**, and **graveyarded**.

```
  running  ──[x]──▶  offline  ──[x]──▶  graveyard
                      │                     │
                      ◀──Enter──            ◀── aimux graveyard resurrect
```

```bash
# List agents in the graveyard
aimux graveyard list

# Resurrect an agent back to offline state
aimux graveyard resurrect <id>
```

Context files (`.aimux/context/`, `.aimux/history/`) are never deleted — only the agent's state changes.

## Worktrees

aimux manages git worktrees as sibling directories:

```bash
# Create a worktree
aimux worktree create fix-auth

# List worktrees
aimux worktree list

# Clean up offline worktrees
aimux worktree clean

# Remove a specific worktree
aimux worktree remove fix-auth
```

Worktrees are created at `../{repo-name}-{worktree-name}/` and each gets its own `.aimux/` directory.

## Requirements

- macOS (Linux support planned)
- Node.js >= 18
- At least one supported AI tool installed: `claude`, `codex`, or `aider`
- Notifications work out of the box on macOS, Linux, and Windows

## License

MIT
