# Aimux Contract Fixtures v1

This directory is the shared fixture root for TypeScript-to-Rust parity tests.
Fixtures here must be consumable by both Vitest and `cargo test`.

Golden updates must be explicit. Use `UPDATE_CONTRACT_GOLDENS=1` only in tests
that intentionally support rewriting expected outputs.

Priority fixture groups:

1. `project-api`: route shapes, mutation invalidations, HTTP/SSE payloads.
2. `core-command`: daemon command names and core HTTP route shapes.
3. `agent-output`: parser fixtures, streaming diffs, liveness transitions.
4. `ansi`: SGR spans and terminal display formatting.
5. `tmux`: command argv, inventory rows, pane captures, statusline artifacts.
6. `project-catalog`: registry, topology, desktop-state project summaries.

## ANSI

- `ansi/sgr-spans.json`: ANSI SGR span cases, including adversarial color,
  reset, inverse, multiline, unsupported-code, and malformed-escape inputs,
  captured by running the TypeScript `app/lib/ansi.ts` parser.

## Agent Output

- `agent-output/parser-adversarial.json`: golden `{ input, output }` cases
  captured by running the TypeScript `parseAgentOutput` implementation against
  the exported adversarial fixtures and `src/agent-output-parser.test.ts`
  literals.
- `agent-output/parser-fuzz.json`: frozen deterministic parser fuzz corpus
  captured by running the TypeScript fuzz generator in
  `src/agent-output-parser-fuzz.test.ts`.
- `agent-output/transcript.json`: transcript projection and published
  attachment merge cases captured by running the TypeScript
  `agent-transcript` APIs against `src/agent-transcript.test.ts` inputs.
- `agent-output/tracker.json`: `AgentTracker` event, `markSeen`,
  `setActivity`, `setAttention`, focus-suppression, and derived-count
  transition snapshots captured from the TypeScript metadata store path.
- `agent-output/bounds.json`: capture-window clamping and end-line contracts
  captured from the TypeScript `agent-output-bounds` helpers.
- `agent-output/stream.json`: SSE text handler output, tail notice, overlap,
  resync, and error contracts captured from the TypeScript stream handler.
- `agent-output/read-metrics.json`: output-read metric aggregation and recent
  ring-buffer behavior captured from the TypeScript metric accumulator.
