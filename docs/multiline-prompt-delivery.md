# Multiline prompt delivery

Submitted prompts preserve literal LF, blank lines, indentation and tabs. A numbered list remains a list on the CLI, TUI and app input routes, through relay forwarding, coordination delivery, watcher turns and queued retries. Clients forward the body; the project service normalizes it at the shared delivery boundary.

## Shape and safety

`normalize_submitted_prompt` keeps the existing terminal CR/LF trimming: those trailing line endings are framing, not extra submit requests. It canonicalizes embedded CRLF and bare CR to LF. CR must never travel inside the prompt body because it means submit to an agent composer. The former whitespace-run collapsing is removed. Horizontal spacing and internal blank lines remain intact.

The whole body crosses one staged file load and one body paste. `paste-buffer -r` keeps LF from becoming CR. A separate carriage return submits after the paste completes. Staged files are private and removed after loading; a failed paste retains its original error and attempts named-buffer cleanup with an independent timeout budget.

Known Claude and Codex receivers get explicit opening and closing paste markers around that one body paste, in one tmux command group. The body paste omits `-p` to avoid double framing and retains tmux's existing control-sequence sanitation; it does not add `-S`. Paste events bypass keyboard bindings, so remapping Ctrl+J to submit cannot turn an embedded LF into an early turn. A unique pane token tracks an open frame and is cleared before acknowledgement. Failed delivery attempts a bounded, token-matched closing marker without submitting; late cleanup cannot close a completed or newer frame.

This uses source evidence rather than assuming the tool's default bindings are immutable. [Claude supports live keyboard remapping](https://code.claude.com/docs/en/keybindings#configuration-file); [Codex's C0-LF test](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/textarea.rs#L3389-L3397) only proves its default textarea keymap. Codex's pinned parser recognizes paste markers independently of advertised mode and routes the resulting Paste event directly to insertion. The installed Claude Code 2.1.285 binary similarly parses markers into paste events before key dispatch; its own background interactive transport writes the same markers and then CR. The inspected binary SHA-256 is `51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4`; parser offset 188478273 and dispatch offset 188528988. No provider agent was launched for this inspection.

Capability classification uses the raw recorded launch command, including absolute executables, rather than a configurable display key or projected fallback. Missing or null commands remain unknown.

Other receivers, including shells and custom editors, must advertise bracketed-paste support for multiline bodies. The service uses synchronous tmux `if-shell -F` to check the target pane and execute its paste in the same command-queue turn. It requires an exact success acknowledgement after the paste; refusal, empty or malformed acknowledgements are errors. An earlier capability query would race a receiver disabling paste mode before `paste-buffer -p`, so there is no separate query gate or flattening fallback. Single-line delivery needs no paste-mode guard.

Existing composer, attachment and shared-attribution formatting still applies before delivery. Context metadata retains its existing bounded single-line representation; it does not flatten the user's body.

## Submission verification work

Queue items 947602-130 and 947602-132 own the separate question of whether a rendered draft and subsequent submit can be verified. The `submit-verification` branch and its working changes were read; it had no published PR during this design. Keeping LF makes complete-draft verification depend on multiline composer extraction or a truthful unverified receipt. First-line or sentence-fragment matches must not be promoted into complete-body evidence. This change preserves one explicit submit after body delivery and propagates transport refusal before submission. Explicit framing makes transport safe under remapped keys; its tmux acknowledgement does not prove provider turn acceptance. Collapsed multiline paste markers still belong on that branch's unverified-receipt path, rather than being promoted to complete rendered-body evidence.

PR #467 supplied concrete sync/async production delivery seams, staging privacy checks and independent cleanup budgets; those remain exercised here. PR #468 added loop-briefing staging cases and historical head-loss evidence. This change preserves their one-load/one-paste invariant and removes the shape collapse from normalized loop payloads too.

## Verification boundaries

`one_submit_after_the_whole_multiline_body_lands` uses an owned private tmux server and controlled raw-terminal composers. Independently expected received bytes, premature turn counts, complete-body timestamps, final submit count and paste boundaries are checked through both real input routes and sync/async executors. Known receivers with LF-as-submit keybindings and default LF-as-data bindings are distinct peer protocols; explicit framing must protect both. Unknown mode-off receivers must receive no bytes; mode-on receivers accept the complete body. Mislabelled shell commands and missing/null launch commands cannot borrow a Claude label's capability; genuine Claude/Codex command aliases remain supported.

These tests prove transport behavior and the stated receiver protocols. They do not launch provider agents, spend provider tokens, install a local release or claim that the user's installed runtime has changed. Active-frame and newer-owner cleanup also have focused unit coverage; the real stale-close scenario covers an already-cleared token. Full suites belong to CI.
