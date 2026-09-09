# PTY Recording Dead Writer v1

Status: RETIRED. Session recording writer stays removed; legacy recording cleanup stays.

## Finding

The session recording writer is dead code. `src/recorder.ts` still defines a `Recorder` that appends raw PTY output to `<session-id>.log` and stripped plaintext output to `<session-id>.txt`, but no current TypeScript or Rust runtime path constructs it or writes those files.

This is pre-existing, not caused by the Rust rewrite. The native tree ports cleanup and migration handling for recording files, not recording creation. New project init no longer creates a recordings directory that nothing writes to.

## Decision

Do not restore PTY session recording. The writer has been dead since `0098853a` on 2026-03-30 and nobody noticed for five months. Aimux already has agent output capture, transcripts, scrollback, and Expose pane taps through the native tmux runtime; restoring recording would add a second contended pane-output consumer with no demonstrated demand.

Keep `recording_cleanup.rs`, graveyard cleanup integration, runtime migration handling, and the `recordings/` `.gitignore` entry. They service real legacy `.log` and `.txt` files that may still exist on disk and should remain ignored and cleanable.

## What The Feature Was

The original feature recorded each PTY-backed session into the project recording directory:

- raw stream: `.aimux/recordings/<session-id>.log`
- stripped text stream: `.aimux/recordings/<session-id>.txt`

The text stream used `stripTerminal` in `src/recorder.ts`, which removed terminal control sequences and converted cursor-right CSI sequences into spaces.

The live writer path was:

- `src/pty-session.ts` imported `Recorder`.
- `PtySession` constructed `new Recorder(this.id)` unless `record === false`.
- `process.onData` called `this.recorder?.write(data)`.
- `process.onExit` called `this.recorder?.close()`.

## When It Disappeared

Git history points to commit `0098853a Delete legacy server and pty runtime code` on `2026-03-30 11:23:28 +0800`.

That commit deleted `src/pty-session.ts`, `src/server.ts`, `src/runtime-backend.ts`, and the old server runtime manager. It also rewired multiplexer session creation to always use tmux-backed runtime windows instead of the legacy direct PTY/server runtime path.

Before that commit:

```text
0098853a^:src/pty-session.ts imported Recorder
0098853a^:src/pty-session.ts constructed new Recorder(this.id)
0098853a^:src/pty-session.ts called recorder.write(data)
```

After that commit:

```text
0098853a:src/recorder.ts still exists
0098853a:src/pty-session.ts is deleted
0098853a: no remaining caller constructs Recorder
```

Current source search confirms the same state: no `new Recorder`, no `recorder.write`, and no native append writer for `.aimux/recordings/*.log` or `.aimux/recordings/*.txt`.

## Cleanup Survived

Recording cleanup was added later, independent of any writer:

- `c3098609 feat(daemon): sweep recordings the graveyard can no longer reach`
- `29b632d7 feat(daemon): give the recording sweep its own gate, reach and guard`
- `7276ee01 fixtures: enforce cleanup recording contracts`

Those commits sweep or remove existing `.log` and `.txt` files, including old files from before the writer died. They do not recreate the writer.

The Rust port mirrors this cleanup behavior in `native/crates/aimux/src/recording_cleanup.rs` and graveyard cleanup code. It does not contain the missing creation path.

## Retired Restore Path

If this feature is ever brought back, restoration should be a native tmux-output recording feature, not a revival of the old Node `Recorder`.

A minimal faithful restore would need:

- a Rust terminal-stripper equivalent to `stripTerminal`, or reuse of the existing Rust ANSI/SGR parsing stack if it fully covers cursor movement, OSC, DCS, charset designation, control characters, and carriage-return cleanup;
- a single per-session writer owner in the tmux runtime path that appends raw pane output and stripped text;
- integration with the existing tmux pipe ownership code so recording does not compete with Expose pane-output taps;
- lifecycle close/flush behavior when a managed window/session exits or is graveyarded;
- contract fixtures captured before TypeScript deletion for `stripTerminal` behavior if preserving exact text output matters.

The likely native attach point is the tmux pane output tap layer, because that is already the supported way to stream pane output from tmux. The important constraint is single ownership: recording, Expose, and dashboard consumers should share one pane-output stream/cache instead of installing independent pipes.

## Phase 8 Impact

`src/recorder.ts` remains safe to delete in Phase 8 because it has no current caller and no active writer behavior. Deleting it does not remove a live feature; it removes the unused writer shell left behind after `0098853a`.

The user-visible bug is older than Phase 8: Aimux still advertises and cleans recording files, but current sessions do not write them.
