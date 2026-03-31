# Desktop Shell Phase 1 Spec

## Status

Draft

## Summary

Phase 1 is a thin desktop shell over the current aimux runtime.

We will not build a second client model, a second orchestrator, or a GUI-native workflow layer.

We will build:

- a `Tauri` desktop app
- a project/session browser
- an embedded terminal host for the existing aimux TUI and agent windows
- a thin local control API for discovery and basic actions

We will not build in Phase 1:

- GUI-only orchestration features
- a separate desktop backend service
- native diff/task/artifact panels driven by ad hoc scraping
- a replacement for the TUI dashboard

## Current Codebase Reality

The current codebase already gives us most of the runtime substrate we need.

### Existing runtime pieces we should reuse

- `src/tmux-runtime-manager.ts`
  - authoritative tmux session/window management
- `src/multiplexer.ts`
  - canonical dashboard/session lifecycle
- `src/metadata-server.ts`
  - per-project local HTTP surface
- `src/metadata-store.ts`
  - persisted metadata and endpoint discovery
- `src/project-scanner.ts`
  - global project/session discovery across registered and legacy projects
- `src/dashboard-session-registry.ts`
  - dashboard-shaped session enrichment
- `src/paths.ts`
  - global project registry and project-state directory layout
- `src/tmux-statusline.ts`
  - file-backed lightweight project/session summary

### Important constraints from the current implementation

- aimux is already tmux-backed by design
- session/project state is split between in-repo `.aimux/` and global `~/.aimux/projects/<id>/`
- project discovery is file-backed and synchronous today
- metadata HTTP is per-project, not global
- there is no desktop-oriented control API yet
- there is no stable way for an external app to say "open this project dashboard" or "focus this agent window" except by reproducing internal tmux logic

This spec solves only those missing seams needed for a desktop shell.

## Product Scope

Phase 1 desktop must do four things well:

1. show discoverable aimux projects and whether they appear live
2. open a project into the canonical aimux dashboard
3. focus an existing agent session in its real tmux-backed terminal
4. host the actual terminal surface inside a desktop window

If those four things work, we have a real desktop shell.

## User Flows

### Flow 1: Open a project dashboard

1. User launches the desktop app.
2. App lists known aimux projects.
3. User selects a project.
4. App launches or attaches to that project's aimux dashboard.
5. The dashboard is shown inside the desktop terminal view.

### Flow 2: Rejoin an agent

1. User sees a project with active sessions.
2. User selects a session.
3. App focuses that session's tmux window.
4. The live agent terminal is shown inside the desktop terminal view.

### Flow 3: Return to dashboard

1. User is focused on an agent window.
2. User clicks "Dashboard".
3. App focuses tmux window `0:dashboard`.

### Flow 4: Browse without opening

1. User opens the desktop app.
2. App shows project/session summaries from file-backed state.
3. User can inspect which projects appear active before attaching anywhere.

This is intentionally modest. It is enough to prove the desktop shell without inventing new product behavior.

## Technical Decision

Phase 1 should use:

- `Tauri` for the desktop container
- a terminal frontend in the webview
- a Rust-side PTY process host for local aimux commands
- small CLI/API additions in the aimux Node codebase for discovery and control

We should not make the Tauri app responsible for understanding aimux state directly from filesystem conventions. That logic already exists in the repo and should stay here.

## Architecture

### 1. Desktop app responsibilities

The desktop app owns:

- native window lifecycle
- terminal tab/view lifecycle
- shelling out to aimux commands
- a lightweight project/session browser UI
- desktop notifications later if needed

The desktop app does not own:

- project discovery rules
- session enrichment rules
- tmux target resolution
- orchestration semantics

### 2. Aimux core responsibilities

Aimux core owns:

- project discovery
- project/session summaries
- tmux session naming and window targeting
- dashboard launch/attach behavior
- session focus behavior

### 3. Integration boundary

Phase 1 should use two integration modes:

- discovery via JSON CLI commands
- terminal hosting via PTY-launched aimux commands

This is simpler and safer than introducing a new long-running desktop daemon.

## Phase 1 Interfaces

We need a small set of explicit external interfaces.

### A. `aimux projects list --json`

Purpose:

- provide a stable discovery surface for the desktop app

Implementation source:

- build on `src/project-scanner.ts`
- enrich using global registry data from `src/paths.ts`

Output shape:

```json
{
  "projects": [
    {
      "id": "repo-123",
      "name": "repo",
      "path": "/abs/path/repo",
      "dashboardSessionName": "aimux-repo-abc123",
      "sessions": [
        {
          "id": "codex-ab12cd",
          "tool": "codex",
          "label": "reviewer",
          "headline": "check task queue race",
          "status": "running",
          "role": "reviewer",
          "worktreePath": "/abs/path/repo-wt-review"
        }
      ]
    }
  ]
}
```

Notes:

- `dashboardSessionName` should come from `TmuxRuntimeManager.getProjectSession(projectRoot)`

### B. `aimux desktop open --project <path>`

Purpose:

- open or attach to the canonical dashboard for a project

Expected behavior:

- resolve the main repo root
- ensure the managed tmux session exists
- ensure the dashboard window exists
- attach the launched PTY to the dashboard view

Phase 1 implementation approach:

- this can be a very thin wrapper around the existing default `aimux` dashboard launch path
- if needed, add a non-interactive attach path that guarantees the process enters the right tmux session/window for PTY hosting

### C. `aimux desktop focus --project <path> --session <id>`

Purpose:

- focus a known aimux session by session id

Implementation source:

- reuse state/instance lookup already present in `src/multiplexer.ts`
- resolve `session id -> tmux target`
- open that tmux target

Important detail:

This command must not require the desktop app to know tmux window IDs or recreate aimux targeting logic.

### D. `aimux desktop dashboard-target --project <path> --json`

Purpose:

- optionally expose the resolved tmux dashboard target for debugging and future desktop use

This is not required for the first UI, but it is a useful seam for tests and tooling.

## Why CLI First Instead of HTTP First

The codebase already has a per-project metadata HTTP server, but it is the wrong primary boundary for Phase 1 because:

- it is per-project rather than global
- it does not expose project discovery
- it does not expose window focus/open actions
- desktop startup should not depend on a live metadata server already existing

CLI JSON commands are the right first step because they:

- reuse current code with minimal new architecture
- work whether a project is currently live or offline
- are easy to test
- create a clean stepping stone toward richer APIs later

## Desktop UI Scope

The desktop UI should have only two major surfaces in Phase 1.

### 1. Sidebar

Shows:

- projects
- project activity state
- session list for the selected project

Actions:

- open dashboard
- focus session
- refresh

### 2. Terminal surface

Shows:

- the actual aimux dashboard or agent terminal

Requirements:

- full keyboard pass-through
- correct resize handling
- no desktop-side interpretation of aimux keybindings
- one visible terminal tab at a time for Phase 1

Nice-to-have but not required:

- multiple tabs
- pinned sessions
- split views

## Minimum Code Changes In Aimux

This is the important part. We should keep the change set small and obvious.

### 1. Add project discovery JSON command

Files likely touched:

- `src/main.ts`
- `src/project-scanner.ts`

Deliverable:

- `aimux projects list --json`

### 2. Add desktop-focused open/focus commands

Files likely touched:

- `src/main.ts`
- `src/multiplexer.ts`
- `src/tmux-runtime-manager.ts`

Deliverables:

- `aimux desktop open --project <path>`
- `aimux desktop focus --project <path> --session <id>`

### 3. Extract any duplicated project/session shaping into shared TS logic

Files likely touched:

- `src/project-scanner.ts`
- maybe a new `src/desktop-state.ts` if shaping becomes non-trivial

Goal:

- no reimplementation of scanning rules in the Tauri app

### 4. Keep metadata server unchanged for Phase 1 unless a small additive endpoint is clearly useful

We should avoid inventing a global desktop HTTP layer before the shell exists.

## Commands and Process Model

### Startup path

Desktop app startup:

1. run `aimux projects list --json`
2. render project/session browser
3. on open, spawn PTY with `aimux desktop open --project <path>`

### Focus path

When the user selects a session:

1. terminate or reuse the current PTY view
2. spawn PTY with `aimux desktop focus --project <path> --session <id>`
3. PTY process attaches into the selected tmux window

This keeps the desktop host simple.

It also means the desktop app does not need to speak tmux directly in Phase 1.

## Tmux Boundary

This spec deliberately avoids direct `tmux` control mode use in the desktop app for Phase 1.

Reason:

- aimux already owns tmux semantics
- direct desktop-to-tmux coupling would duplicate targeting logic immediately
- PTY-launched `aimux` commands are enough to prove the shell

This does not contradict the earlier RFC.

It means:

- `tmux` remains the runtime substrate
- aimux remains the tmux authority
- the desktop app talks to aimux, not directly to tmux

If we later need richer embedding or lower-latency target switching, we can add a tighter tmux integration after the shell exists.

## Acceptance Criteria

Phase 1 is complete when all of the following are true:

- desktop app can list known aimux projects using a stable JSON command
- desktop app can open a project dashboard in an embedded terminal
- desktop app can focus an existing session in an embedded terminal
- no project/session discovery logic is duplicated in the desktop codebase
- no GUI-only orchestration behavior exists
- the same sessions remain usable from a normal terminal outside the desktop app

## Non-Goals

- native GUI rendering of dashboard/session content
- desktop-side parsing of ANSI output into domain objects
- task graph views
- diff viewers
- artifact browsers
- global daemon architecture
- replacing any legacy desktop shell assumptions in the same change

## Risks

### 1. PTY attach UX may be rough

Embedding terminal sessions is always slightly awkward at first.

Mitigation:

- keep scope small
- optimize for correctness and keyboard fidelity first

### 2. Open/focus commands may expose awkward assumptions in current `Multiplexer`

Some session targeting logic is still internal.

Mitigation:

- add narrow explicit CLI entry points instead of leaking internals into the desktop app

### 3. Project summaries may be slightly inconsistent across file sources

That already exists today between registry, instances, state, metadata, and statusline files.

Mitigation:

- centralize shaping in TS now
- do not duplicate those heuristics in Tauri

## Implementation Plan

1. Add `aimux projects list --json`.
2. Add `aimux desktop open --project <path>`.
3. Add `aimux desktop focus --project <path> --session <id>`.
4. Verify those commands manually in terminal first.
5. Scaffold the `Tauri` app only after the CLI surfaces are stable.

## Coding Start Point

The first coding step should be the CLI surface, not the desktop shell.

Specifically:

- implement project discovery JSON output
- implement open/focus commands backed by existing tmux/runtime logic

Once those exist, the `Tauri` app becomes straightforward glue instead of a speculative architecture exercise.
