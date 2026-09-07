# Unimplemented Contract Consumers

This inventory lists real captured TypeScript contract corpora that are intentionally `#[ignore]` because the matching Rust API does not exist yet, the implementation sits behind an ownership fence, or the existing fenced Rust implementation currently differs from the captured TypeScript behavior. It deliberately does not count Vitest reporter output as coverage.

Coverage definition used for this inventory: a `src` test module is covered when any `testdata/contracts/v1/**/*.json` fixture records that module in a top-level `source`, top-level `sources`, case `source`, or group/case `source` field, and the fixture contains behavior-level input/output or state data rather than test-runner metadata. Under that definition there are 245 `src` test modules, 245 covered modules, and 0 uncovered modules remaining.

There are 0 ignored corpus entries below, covering 0 captured checklist cases.

| Consumer | Corpus | Cases | Missing Rust API / parity bug | Ownership fence |
| --- | --- | ---: | --- | --- |

## Honest Uncovered Gaps

No uncovered `src/**/*.test.ts` modules remain under this coverage definition.
