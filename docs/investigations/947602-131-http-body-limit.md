# HTTP body limit before buffering

Baseline: master `592d0e46d` (2026-10-18). Both project-service connection
readers buffered the declared body before consulting `body_limit_for_route`.
The daemon already had a bounded transport and a prepared-response rejection
outcome; the project service now adopts that mechanism.

The limit travels out of band as a prepared response, so oversize remains 413
without changing the shared `DaemonListenerError` enum or mapping I/O errors
to size errors. The outer project listener previously logged transport errors
and closed the connection; returning `InvalidRequest` alone would not produce
the required 413 response.

## Policy

The existing route policy remains authoritative: ordinary requests get 1 MiB;
`POST /attachments`, including its query form, gets 13,989,208 bytes (the
base64 expansion of a 10 MiB attachment plus an 8 KiB JSON envelope).
`/attachments/publish` keeps the ordinary budget. All project HTTP methods
use that policy at the transport boundary.

| Input | Outcome |
| --- | --- |
| Declared length above the route budget | Prepared 413, no body bytes read |
| In-budget fixed length | Read exactly that message; trailing bytes remain unread |
| Short body or malformed/ambiguous framing | Prepared 400 |
| Read failure | Original I/O error, including its cause |
| Chunked payload exceeds the route budget | Prepared 413 once the chunk declaration proves excess |
| Chunked extensions/trailers exceed 64 KiB total framing | Prepared 400 |

Chunked limits count decoded payload bytes. A separate 64 KiB aggregate
framing budget bounds the retained wire representation, including extensions,
terminators and trailers. An 8 KiB read may look ahead past a chunk header;
fixed-length reads do not look ahead beyond the declared body. Retained raw
length is bounded by headers, payload budget, framing budget and one read;
vector capacity growth and finite parser copies add bounded allocation overhead.

Recovered Node `a9220736^:src/metadata-server/http.ts` counts decoded
`IncomingMessage` chunks. Decoded-payload accounting preserves that behavior.
The aggregate chunk-framing cap deliberately differs from Node: unusually
fragmented requests or very large extensions/trailers can receive 400 while
their decoded payload still fits. This prevents small payloads from creating
unbounded retained framing. Duplicate conflicting lengths, mixed length and
transfer encoding, unsupported transfer encodings and incomplete messages
also receive explicit 400 responses in both bounded transports.

Project-service oversize responses retain the existing CORS headers and denied
origins retain 403. Shared daemon callers still supply their own prepared
oversize response and route limits.

## Verification

The `http_body_limits` target has 13 tests driving the actual sync/async
project connections and sync/async bounded daemon handlers with counted
input streams. The attachment test sends a correctly padded base64 payload,
asserts HTTP 200 and the stored 10,485,760-byte attachment size, then tests the
literal 13,989,208-byte body ceiling and its inverse. Existing `daemon_listener`
(15 tests), `project_service_server` (11 tests), and the two existing
`project_service::process::tests::async_connection_*` unit tests also passed.

The following production mutations each produced a named test failure, then
passed the same gate after restoring pristine source. Compiler failures and
zero-test runs do not count as mutation evidence.

| Mutation | Failing gate |
| --- | --- |
| Delay declared-size check until the whole body is read | All four `*_declared_oversize_413_before_body` tests fail consumed-byte assertions: 1,048,685 bytes instead of 108 |
| Change configured rejection status to 400 | All four `*_declared_oversize_413_before_body` tests fail their 413 assertions |
| Classify short EOF as an oversize rejection | `short_bodies_are_400_and_stream_errors_remain_io_errors` |
| Double the attachment route policy | `the_literal_attachment_budget_accepts_a_real_ten_mib_file_and_cannot_expand` fails its independent literal budget assertion |
| Double only the project transport ceiling, leaving the downstream policy unchanged | `the_literal_attachment_budget_accepts_a_real_ten_mib_file_and_cannot_expand` reaches the real endpoint and fails with 400 instead of the required early 413 |
| Read a whole buffer beyond the fixed declared length | `fixed_length_reads_stop_at_the_declared_body_and_accept_the_exact_ordinary_limit` |
| Charge chunk framing against the decoded payload budget | `chunked_limit_counts_decoded_bytes_and_preserves_valid_trailers` |
| Remove the aggregate chunk-framing bound | `aggregate_chunk_framing_accepts_exactly_64_kib_and_rejects_one_more_byte` |
| Convert the original I/O failure into 413 | `short_bodies_are_400_and_stream_errors_remain_io_errors` |

These are protocol/stream-consumption tests in isolated fixture contexts.
No shared daemon or project-service fleet has been restarted for this change.
