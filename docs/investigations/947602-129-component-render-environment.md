# Component render environment and composer regression proof

Baseline: master `137a79985` (2026-10-18). The app had Vitest Node tests and
source-text guards, but no DOM environment or component renderer.

## Environment and lane choice

Use two projects in the existing app CI lane: pure tests remain in Node;
only `*.component.test.tsx` starts jsdom, with React Testing Library and an
exact React Native to React Native Web alias. This keeps the local pure lane
fast while ensuring the unchanged CI app-test command always includes the
component project. `test:unit` and `test:components` select a project explicitly.
The root `yarn verify` command still typechecks app tests without running them.

These are mounted web components, not native iOS/Android rendering or browser
layout tests. Native bridges, transport/auth/navigation and icons are boundary
doubles. The screen, Jotai stores, input/send controls, delivery/footer helpers,
inline footer view and React Native Web text/primitives remain real. The held
assertion observes the icon and color selected by the real footer branch;
it does not assert computed Tailwind CSS. Transcript rows are stubbed, so the
chat-mode inverse proves footer suppression, not transcript-row rendering.

## Tests

`AgentChatScreen.component.test.tsx` enters text in the actual textbox, selects
an output mode through the actual control, clicks Send and checks API arguments
and rendered results. Four cases cover terminal-mode accepted input awaiting
its echo, held accepted input with an amber Clock instead of an error, a genuine
failure with the draft preserved, and the chat-mode inverse. It does not mock
React state, the screen or footer decisions. The obsolete footer source-text
assertions were removed; unrelated source guards remain scoped as before.

`ComposerControl.component.test.tsx` also checks the production button's
accessible action, narrow label and enabled/disabled press behavior.

## Literal historical replay

[PR #435's adversarial review](https://github.com/TraderSamwise/aimux/pull/435#issuecomment-6146480746)
reported two one-token edits that restored the original bug despite green
source and pure gates:

1. `transcriptVisible: chatViewVisible` → `transcriptVisible: true`.
2. `livePaneInputDeliveryOutcome(sendResponse.delivery) === "pending"` → `=== "failed"`.

Those call sites have since been refactored away. To test the literal edits,
temporarily overlay `app/components/screens/AgentChatScreen.tsx` and its
`app/lib/composer-protocol.ts` helper from `d3757f24e2944c8062ee7f257633f2ca179df220`,
then run the same new mounted component test. The old helper supplies the
historical `composerSendNotice` export; no new compatibility code was added
to production. All four tests pass on that unmodified historical baseline.

Each original edit then fails its named DOM assertion independently:

| Edit | Named failing test | Observed failure |
| --- | --- | --- |
| `transcriptVisible: true` | `renders an accepted send awaiting its echo in terminal mode` | The visible send notice is absent |
| `"pending"` → `"failed"` | `renders accepted held input as pending rather than an error` | The notice still exists, but its amber Clock is absent; the error branch rendered |

Restoring the historical pristine source passes the corresponding test after
each edit. Applying both edits together fails exactly those two tests while
the other two pass; restoring passes all four again. Finally, restore current
production files byte for byte and pass all five component tests. This is a
fresh component-test replay of the historical edits, not a claim that the
historical 1,234-test app suite was rerun locally.

## Current-source and configuration mutations

The current equivalents also fail: hardwire the footer's mode to `"chat"`,
or change the screen's held discriminant from `"held"` to `"error"`. Removing
`<ComposerFooterContentView content={composerFooterStateValue} />` fails the
terminal notice assertion. Removing the component project's `environment:
"jsdom"` fails all five named component tests on missing DOM access, with a
nonzero exit; no suite skips or silently succeeds. Every restored gate passes.
All seven mutation runs produced named runtime test failures, not
TypeScript/import errors.

## Cost and verification

Controlled scoped measurements used one worker, three repetitions and the
same 38 pure composer tests: old Node config median 0.686 s, new Node project
0.602 s. The five new component tests median 1.219 s including process startup.
Individual render runs reported about 0.24–0.35 s of jsdom initialization.
These are scoped measurements, not a full-suite benchmark or claimed speedup.

Root `yarn verify` wall time was 73.83 s before adding the environment and
58.08 s after phase one and 57.53 s after the completed change. These wall
times include cache and host-load variation and are not a claimed speedup;
the root lane does not start jsdom. The scoped app run passed 48 tests, and
changed-file lint passed. Full local suites are intentionally left to CI.

After merging upstream `ab8f55f89` (Linux/npm packaging and Rust changes),
all 49 scoped app tests passed on the integrated head and `yarn verify` passed
in 93.17 s. That run includes new upstream code and is not a controlled
render-environment timing comparison.
