# Cross-tool usage monitoring

`aimux usage` reads each tool’s quota windows and token spend from the project
service. It is a top-level command because the same mixed-fleet snapshot is
useful to any agent, independently of its own runtime or a loop goal.

```sh
aimux usage --project /path/to/project
aimux usage --json
aimux usage --refresh
```

`--refresh` kicks the shared collector on the next scheduler tick and returns
the current cached snapshot. Normal collection runs every five minutes, measured
from completion. Read requests use the cache; collection never scans whole
transcripts or spawns tools. The CLI, TUI Usage screen and app render the
service’s `displayLines` in the supplied order.
In the TUI, press **Shift+U** to open Usage, use Up/Down to scroll, and press
Escape to return. JSON also includes collection timestamps, source session IDs,
reset timestamps, reported window durations, and explicit `known`, `absent`, or
`error` outcomes.
A successfully read error snapshot retains its error state and cause; transport
and malformed response failures make the CLI exit nonzero.

## Sources and limits

- Claude quotas come from its supported [statusline JSON input](https://code.claude.com/docs/en/statusline):
  `rate_limits.five_hour`, `seven_day`, and additional reported buckets. Aimux
  composes a callback with the effective existing statusline command at launch,
  forwarding its original input, output and exit status. On Unix the user shell
  replaces the callback process; complete input uses a private, already-unlinked
  stdin file, independently of the collection limit. Each normal callback
  rereads the effective user settings and refreshes copied explicit settings when
  changed, so edits apply on the next callback without a polling watcher.
  Existing running Claude sessions acquire this callback on their next launch
  or restart.
- Codex quotas come from the newest complete reported `token_count` observation
  for each metered bucket in a bounded rollout tail. Windows are identified by
  their reported duration: `primary` can be weekly. Additional windows remain separate. The upstream
  [protocol schema](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
  describes these runtime observations.
- Quota percentages describe the reporting session’s account snapshot. They are
  never summed across sessions. A missing window is unknown, not zero. An
  expired snapshot becomes unknown until the runtime reports its next window.
  Aimux never invents a limit or derives quota percentages from token totals.
- Token spend uses the existing `agent_token_spend` normalization: fresh input,
  cache writes and output, excluding cache reads for both runtimes. This is a
  billed-equivalent token count, not dollars. Other configured tools remain
  visible with unknown usage until their runtime provides a supported source.

Tokens are measured **since monitoring started**, not across an account’s
billing window. First sight of a Claude transcript takes an EOF baseline with
`stat`, parsing no history; subsequent reads are capped at 4 MiB. Codex reads
at most a 4 MiB tail. Per-session baselines and accumulated spend persist in
`usage-monitor.json` under the project state directory, independently of loop
budgets. Restarting the service preserves spend; changing a transcript or backend
starts a new baseline while retaining already observed spend. Unobserved tokens
during a rollover cannot be reconstructed and are not guessed.

`GET /usage` serves the cached snapshot; `GET /usage?refresh=1` also kicks
collection. The internal Claude callback posts sanitized quota fields to
`POST /usage/claude/statusline`, which validates the known Claude session and
stores observations through the project service. It requires no provider
credentials and makes no provider network calls. File, parser and collection
failures retain an explicit error with its source and cause. Genuine absence follows the unknown
path. The existing `/usage/mark` navigation-recency endpoint is independent.

## Regression and mutation evidence

The scoped checks compare the real desktop-state projection, service route,
daemon CLI text, TUI Usage screen, and app dashboard through
`service_cli_tui_and_app_render_the_same_usage_outcomes`.
Provider fixtures also cover cold baselines, restart persistence, duplicate live
and stale sessions, configured aliases, extra buckets, expired windows, raw spend,
partial records and explicit collection failures.

On 2026-10-18, each fault below made the named test fail; restoring pristine
source bytes made it pass. Independent faults were compiled together, with each
failure inspected at its own assertion. The weekly fault was repeated alone
because the combined missing-label fault masked its first lookup.

| Deliberate fault | Test that rejected it |
| --- | --- |
| Missing weekly window becomes known zero | `missing_weekly_known_zero_and_collection_error_survive_service_route` |
| Codex counts cache reads | `persisted_baseline_resumes_without_recounting_and_runtimes_share_a_currency` |
| Per-tool JSON identities become an unlabelled `all` category | `service_route_labels_each_tool_and_keeps_their_usage_separate` |
| Next periodic run is based on the previous due time | `a_task_that_overruns_its_interval_still_gets_a_full_gap_afterwards` |
| Collection error publishes the default empty/unknown snapshot | `malformed_authority_sources_publish_errors_and_do_not_reset_baselines` |

The review fixes also passed these fail/restore checks against the production
paths, beyond the five requested semantic proofs:

| Deliberate fault | Test that rejected it |
| --- | --- |
| Production task loop reuses ticks from before completion | `production_task_loop_overrun_receives_a_full_interval_after_finish` |
| Remove usage from both real desktop-state projection paths | `service_cli_tui_and_app_render_the_same_usage_outcomes` |
| Truncate a long unbroken error path in the TUI | `usage_screen_navigation_reaches_the_final_line_at_eighty_by_twenty_four` |
| Redirect a stale quota without equal backend identities | `stale_claude_statusline_id_follows_the_live_backend_but_not_another_session` |
| Remove UsageMonitor from the actual app dashboard | `renders every service line in order, retaining tool labels, unknowns, errors, and extra windows` |
