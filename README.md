# aimux

Native CLI agent multiplexer — run multiple AI coding tools side-by-side with their native TUIs intact.

aimux wraps tools like [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), and [Aider](https://github.com/paul-gauthier/aider) in PTY proxies, letting you switch between them like tmux panes while sharing context across agents.

## Features

- **Native TUI preservation** — each tool runs in its own PTY, keeping full color, scrollback, and interactivity
- **Leader key switching** — `Ctrl+A` prefix (like GNU screen/tmux) to switch between agents, open dashboard, create/kill sessions
- **Dashboard view** — see all running agents and their status at a glance
- **Context sharing** — agents can read each other's conversation history via `.aimux/context/`
- **Session resume** — resume previous sessions using each tool's native resume (`--resume`) or injected history (`--restore`)
- **Git worktree support** — first-class worktree management for parallel feature work, with per-worktree agent isolation
- **Configurable** — global (`~/.aimux/config.json`) and project-level (`.aimux/config.json`) configuration
- **Notifications** — macOS notifications when agents need attention or complete tasks
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
# Launch with tool picker
aimux

# Launch a specific tool
aimux claude
aimux codex
aimux aider

# Resume previous sessions
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
| `Ctrl+A x` | Kill current agent |
| `Ctrl+A 1-9` | Focus agent by number |
| `Ctrl+A w` | Create new worktree |
| `Ctrl+A W` | Worktree management |
| `Ctrl+A Ctrl+A` | Send literal Ctrl+A |

## Dashboard

When you run `aimux` without arguments (or press `Ctrl+A d`), you get a dashboard showing all agents:

```
         aimux — agent multiplexer
──────────────────────────────────────

  ● [1] claude — running ←
  ● [2] codex — idle

──────────────────────────────────────
 ↑↓ select  Enter focus  [c] new  [q] quit
```

With worktrees, agents are grouped:

```
   (main) — active
    ● [1] claude — running ←

   fix-auth (fix-auth) — active
    ● [2] claude — running

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
- Optional: `terminal-notifier` for macOS notifications

## License

MIT
