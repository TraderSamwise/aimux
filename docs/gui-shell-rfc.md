# GUI Shell RFC

## Status

Draft

## Summary

Aimux is and remains a TUI-first product.

We should still support an optional desktop GUI for users who want desktop ergonomics, richer inspection, and easier onboarding. The GUI must be a shell around the existing terminal-native product, not a separate product line and not a new source of truth.

Near term, the most practical bootstrap is a `Tauri` app that launches or attaches to aimux through a PTY and, where useful, `tmux` control mode.

Long term, the GUI should consume structured aimux state and events. It must not depend on terminal scraping as its primary application model.

## Decision

Aimux will pursue an optional desktop GUI under these constraints:

- aimux remains TUI-first in workflow design and feature priority
- every core orchestration flow must work in the TUI first
- the GUI is a convenience and inspection layer over the same runtime
- `tmux` control mode may be used as a bootstrap transport, not the long-term product API
- structured aimux state, not pane text, is the long-term integration boundary

## Problem

The TUI is the right center of gravity for aimux:

- it matches the terminal-native coding workflow
- it aligns with our tmux runtime architecture
- it keeps operation fast, scriptable, and remote-friendly

But some users still want a desktop surface for:

- session discovery and reconnection
- richer transcript and log search
- artifact and diff inspection
- notifications and backgrounding
- a lower-friction first-run experience

If we ignore that need entirely, we leave adoption and usability gains on the table.

If we solve it badly, we create a worse problem:

- split product direction
- GUI-only features
- duplicated workflows
- terminal output becoming the de facto API

This RFC defines how to capture the upside without losing the TUI-first north star.

## Non-Negotiable Principles

### 1. TUI first is a product rule, not a temporary implementation detail

Aimux is not a GUI product with a terminal fallback.

The TUI defines:

- the canonical interaction model
- command vocabulary
- operator workflow
- feature sequencing for core orchestration

The desktop shell may improve visibility and convenience. It does not redefine how aimux works.

### 2. No GUI-only core workflows

If a feature changes how agents are created, routed, interrupted, coordinated, or reviewed, it must be designed to work in the TUI first.

The GUI may expose the same action more conveniently, but it cannot be the exclusive home of that action.

### 3. Terminal output is not the application model

ANSI output is a rendering stream, not a durable domain contract.

We should never build the desktop experience around inferring core concepts like:

- agent state
- task ownership
- blocked status
- artifact availability
- dependency graph edges

from pane text alone.

### 4. One runtime, one command model

The TUI and GUI must sit over the same runtime and the same orchestration verbs.

We should not create:

- a GUI-specific orchestration engine
- a GUI-only plugin model
- separate action semantics between clients

### 5. If the GUI disappeared, aimux should still make complete sense

This is the simplest drift test.

If removing the GUI would make the core product incomplete or incoherent, we have likely moved too much product value into the wrong layer.

## Proposed Product Framing

Aimux should be described as:

- a terminal-native multi-agent coding and orchestration tool
- with an optional desktop shell for users who want richer inspection and desktop ergonomics

That framing matters because it changes how roadmap decisions get made.

The GUI is not a second front door with equal product authority.
It is an optional host for the same system.

## Why `Tauri`

`Tauri` is a reasonable desktop shell choice because it gives us:

- lightweight cross-platform packaging
- Rust-side process control
- good fit for PTY and `tmux` integration
- a webview for richer inspector surfaces
- a cleaner install/distribution path for users who want a desktop app

This makes it a good host for:

- embedded terminal panes
- session switchers
- transcript browsers
- diff and artifact views
- notifications and background presence

The goal is not to replace the terminal surface. The goal is to wrap it and extend around it.

## Role of `tmux` Control Mode

`tmux` control mode is a valid bootstrap mechanism for a GUI on top of aimux.

It is useful because it lets a desktop client:

- create and manage sessions, windows, and panes
- attach to existing aimux runtime state
- stream terminal output and state changes
- reuse the existing session topology with minimal new backend work

That makes it a good bridge for:

- initial desktop hosting
- remote attach/reconnect
- pane mirroring
- operational compatibility with the live runtime substrate

It is not a sufficient long-term API because it still speaks in terminal primitives rather than aimux domain primitives.

If we stop at `tmux` control mode, the desktop layer will eventually be forced to derive product semantics from terminal state. That is the wrong boundary.

## Architectural Direction

The correct long-term split is:

### 1. Core orchestration layer

Owns:

- sessions
- agents
- task graph
- plans
- attention state
- artifacts
- durable events

### 2. Terminal runtime layer

Owns:

- PTY lifecycle
- `tmux` sessions/windows/panes
- input/output transport
- attach/detach behavior
- screen capture where needed

### 3. TUI renderer

Owns:

- the canonical operator interface
- terminal-native navigation and control
- dashboard and pane-level workflow

### 4. GUI shell

Owns:

- desktop packaging
- multi-session discovery
- notifications
- richer inspector surfaces
- embedded or mirrored terminal views

The GUI should consume the same orchestration state as the TUI, even if early versions still host the TUI through a PTY.

## What the GUI Should Be Good At

The GUI should invest in the places where terminals are naturally weaker:

- session discovery and reconnection
- project switching
- transcript and log search
- diff review
- artifact browsing
- large-history navigation
- notifications, badges, and background presence
- onboarding and account/provider setup flows

These are complements to the terminal workflow, not replacements for it.

## What the GUI Must Not Become

The GUI must not become:

- the only place to spawn or manage agents
- the only place to review or route work
- the place where new orchestration semantics appear first
- a separate product with its own information architecture
- a second implementation of the core runtime model

The easiest way to drift is to keep saying "just for desktop convenience" while introducing GUI-only concepts.

We should explicitly reject that path.

## Rollout Plan

### Phase 1: Desktop host

Build a minimal `Tauri` shell that:

- launches or attaches to aimux
- hosts the existing TUI in a PTY
- optionally uses `tmux` control mode for session attach and pane management
- adds basic desktop concerns like windowing and notifications

Success criteria:

- users can run aimux as-is from a desktop shell
- no TUI workflows are forked
- no terminal scraping is required for core correctness

### Phase 2: Structured sidecar state

Expose a structured aimux event/state layer for:

- projects
- sessions
- agents
- activity
- attention
- tasks
- artifacts
- transcript metadata

This can live in the existing metadata/server architecture rather than as a separate new runtime.

Success criteria:

- the GUI can render side panels without parsing terminal output
- `tmux` remains runtime substrate, not application API

### Phase 3: Native inspection panels

Add GUI-native surfaces for:

- session switcher
- task/dependency view
- diff/artifact inspector
- transcript search
- notifications/history

These should augment the embedded terminal rather than replace it.

Success criteria:

- the desktop app is materially better for inspection-heavy workflows
- the TUI remains complete for operational workflows

### Phase 4: Hybrid control surfaces

Allow the GUI to invoke the same actions the TUI already supports:

- focus agent
- send instruction
- spawn task
- review artifact
- interrupt or resume work

Success criteria:

- one action model across TUI and GUI
- no GUI-only orchestration primitives

## Required Structured State

To prevent the GUI from becoming terminal-driven, aimux should expose at least:

- project identity and runtime status
- session list and ordering
- agent identity, role, label, and runtime target
- activity and attention state
- task assignment and dependency edges
- artifact inventory
- notification stream
- transcript/log metadata
- current focus and recent activity

This state should be considered the contract for secondary surfaces, including any future GUI.

## Evaluation Criteria

We should only continue investing in the GUI if it proves value on things the terminal handles poorly.

Good signs:

- easier onboarding without changing the product model
- better transcript/diff/artifact workflows
- improved reconnection and multi-session navigation
- broader adoption without TUI feature compromise

Bad signs:

- roadmap pressure for GUI-first features
- frequent parity gaps
- terminal output scraping expanding over time
- desktop-only orchestration concepts appearing in design discussions

## Risks

### 1. Product split

The TUI and GUI can drift into separate products with separate expectations.

### 2. Wrong abstraction boundary

If the desktop app depends primarily on `tmux` output, we will hard-code terminal implementation details into product semantics.

### 3. Maintenance burden

A second client surface can consume roadmap bandwidth if not constrained.

### 4. Platform complexity

Desktop packaging introduces OS-specific process, windowing, and PTY concerns that do not directly improve orchestration.

## Mitigations

- require TUI-first design for every core orchestration capability
- keep one runtime and one command model
- invest early in structured state/events
- treat PTY and `tmux` integration as transport, not domain model
- explicitly reject GUI-only core concepts during planning review

## Recommendation

Proceed with an optional `Tauri` desktop shell for aimux.

Do it as a staged extension of the current tmux-backed architecture:

- bootstrap with PTY hosting and selective `tmux` control mode use
- keep the TUI as the canonical operator interface
- add structured state so the GUI can become richer without becoming a fork

This captures the practical upside of a coding GUI while preserving the product's terminal-native identity.

## Immediate Next Steps

1. Treat this RFC as a guardrail document for future desktop work.
2. Define the minimum Phase 1 desktop scope before writing code.
3. Enumerate the structured state/events required for Phase 2.
4. Review existing metadata/server surfaces for reuse instead of inventing a separate desktop backend.
5. Reject any proposed GUI feature that changes core orchestration semantics without a TUI-first design.
