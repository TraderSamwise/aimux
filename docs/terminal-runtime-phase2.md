# Terminal Runtime Phase 2

## Context

Phase 1 established a usable terminal core:

- focused mode is rendered by aimux instead of raw PTY passthrough
- reconnect and hydration are good enough for daily use
- session runtime behavior has started moving out of `multiplexer.ts`
- terminal query handling has a dedicated responder/broker architecture
- Codex and Claude are both usable within the current model

This is the point to stop reactive patching and define the long-term architecture explicitly.

## Goals

Phase 2 exists to make the terminal runtime:

- reliable across reconnect, refocus, resize, and multi-session use
- structurally clear, so terminal behavior does not drift back into `multiplexer.ts`
- compatible enough with Codex-class TUIs that terminal quirks are understandable exceptions, not mysteries
- increasingly server-authoritative for server-backed sessions

## Non-Goals

Phase 2 is not:

- a rewrite around `tmux`
- a quest for perfect compatibility with every terminal app
- a new UI feature phase
- another round of narrow one-off hacks unless a bug is severe enough to justify them

## Current Architecture

The runtime is now split across these layers:

### `Multiplexer`

Owns:

- mode switching
- dashboard and modal state
- high-level session orchestration
- footer/status scheduling

Should not own:

- terminal protocol details
- session startup heuristics
- hydration semantics
- output parsing

### `SessionRuntime`

Owns:

- per-session lifecycle
- loading / hydrating / frame-ready state
- focused resize/focus timing
- session transport integration
- runtime events

Should become the primary per-session control surface.

### `SessionTerminalState`

Owns:

- local terminal viewport model
- cursor state
- structured snapshot export/import
- visible frame rendering input for the focused compositor

Should move toward stronger authority over history/grid state over time.

### `TerminalQueryBroker`

Owns:

- built-in terminal query handlers
- dispatch to compatibility handlers
- conservative fallback seam for unknown queries

Should become the single place where terminal query support is reasoned about.

### `ServerRuntimeManager`

Owns:

- connection to the project server
- server-backed session registration
- hydration orchestration
- server session identity / rename / messaging

Should move toward broader server-runtime authority.

### `FocusedRenderer`

Owns:

- focused-mode compositing
- incremental row diffing
- footer integration
- renderer cache invalidation on resize/refocus

Should remain a renderer, not absorb more runtime semantics.

## Strategic Direction

Phase 2 should move the system toward:

1. thinner controller logic
2. stronger runtime ownership
3. more explicit compatibility boundaries
4. more server-authoritative state for live server sessions

The terminal subsystem should increasingly look like:

- `Multiplexer` coordinates
- `SessionRuntime` owns session behavior
- `SessionTerminalState` owns terminal state
- `TerminalQueryBroker` owns query compatibility
- `FocusedRenderer` owns rendering
- `ServerRuntimeManager` owns server-backed runtime lifecycle

## Workstreams

## 1. Runtime Contract Hardening

### Objective

Make the current subsystem boundaries explicit and testable.

### Work

- formalize interfaces and responsibilities for:
  - `SessionRuntime`
  - `ServerRuntimeManager`
  - `TerminalQueryBroker`
  - `FocusedRenderer`
- add integration-style tests for:
  - startup loading transitions
  - frame-ready transitions
  - reconnect hydration
  - resize/refocus repaint behavior
  - renderer cache invalidation

### Why

The architecture is now good enough that drift is the main risk. This work locks the current shape down before more authority moves across boundaries.

## 2. Server-Authoritative Runtime

### Objective

Reduce the amount of live server-session terminal behavior inferred client-side.

### Work

- push more live runtime state ownership to the server for server-backed sessions
- make client hydration less reconstructive and more snapshot/event driven
- narrow the number of server-session special cases the client needs to know about

### Desired Outcome

For server sessions:

- server owns PTY runtime and more terminal runtime state
- client attaches, renders, and sends input
- reconnect becomes simpler and more coherent across clients

## 3. Query Compatibility Matrix

### Objective

Stop being surprised by terminal query behavior.

### Work

- classify query types:
  - built-in handled
  - safe fallback-forwarded
  - unsupported on purpose
- keep expanding built-ins for high-value cases seen in Codex/Claude
- use the fallback path carefully, with policy and logging
- document the compatibility stance in code and tests

### Desired Outcome

Terminal compatibility becomes a maintained subsystem instead of a sequence of emergency fixes.

## 4. Terminal State Fidelity

### Objective

Make rejoin and long-lived session continuity stronger.

### Work

- improve structured history fidelity
- improve viewport restoration semantics
- reduce remaining gaps between:
  - live attached session
  - detached then rejoined session

### Desired Outcome

Server-backed rejoin should feel boring and trustworthy.

## 5. Performance and Invisible Rendering

### Objective

Make the focused compositor feel native enough that users stop noticing it.

### Work

- profile focused render scheduling in real use
- reduce unnecessary footer paints
- reduce unnecessary full invalidations
- keep incremental rendering honest
- classify remaining Codex-only quirks:
  - worth fixing
  - acceptable
  - better masked in UX than solved in protocol

### Desired Outcome

Rendering should feel like infrastructure, not a feature the user notices constantly.

## Sequencing

Recommended order:

1. Runtime contract hardening
2. Server-authoritative runtime
3. Query compatibility matrix
4. Terminal state fidelity
5. Performance and invisible rendering

This order matters:

- stability before authority shifts
- authority before fidelity improvements
- fidelity before polish

## Open Questions

These should be answered deliberately as Phase 2 advances.

### How server-authoritative should server sessions become?

Strong recommendation:

- server should own more runtime truth than it does now
- clients should hydrate and render, not invent behavior

### How broad should fallback query forwarding become?

Strong recommendation:

- stay conservative
- allowlist categories explicitly
- only widen forwarding when there is a concrete compatibility reason

### How much history fidelity is actually needed?

Strong recommendation:

- optimize for boringly reliable recent-history and viewport continuity first
- do not chase “perfect terminal immortality” before the runtime authority model is cleaner

## Definition of Done for Phase 2

Phase 2 is complete when:

- `multiplexer.ts` is primarily orchestration and UI routing
- server-backed sessions feel coherently owned by the server runtime
- query compatibility is documented and tested
- reconnect behavior is predictable rather than heuristic
- focused rendering is stable enough that remaining quirks are clearly classified tradeoffs

## Practical Rule

Any future terminal fix should be evaluated against this question:

Does this strengthen the runtime architecture, or is it another local patch?

If it is only a patch, prefer to classify the issue and defer it unless it blocks real use.
