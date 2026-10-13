# Node whole-frame goldens

Captured from the Node dashboard renderer and used as literal parity gates.

## Recorded divergences

`dashboard-node-full-frame-v1.txt` and `dashboard-node-control-scribe-frame-v1.txt`
were re-recorded on 2026-10-13 so the agent row stops carrying unlabelled
numbers, and carries a bounded number of them.

Node drew up to seven chips on a row. Two were unreadable: `N unseen`, and a
`thread 8/0/5` triple whose three digits were unread / waiting on me / waiting
on them with nothing on screen to say so. The unread notification count now
sits in a badge beside the agent name, and the rest of these counts say what
they are, in the words the details pane uses for them.

They are also capped at two per row, in priority order, with a `+N more` chip
for what did not fit. Seven chips pushed the next action and the headline off
the end -- a row ending `→ open…` with no headline is worse than one that
shows the two things that matter most. What the row must not do is drop the
rest in silence, which an earlier cut of this change did: the details pane's
own overflow says `{n} more` rather than just ending its list, and that is the
precedent followed here.

Both frames differ by exactly two row lines each. `label-claude-0` gains
`8 threads unread` ahead of `8 pending` and a `+1 more`, and `label-claude-1`
leads with `waiting on you` followed by `8 threads unread` and a `+2 more`
(both headlines truncate by that much). `waiting on you` is read from -- read from the project
service's own `waitingOnMeCount`, already the greater of the thread and
coordination counts, where Node read the two raw fields separately and put a
thread waiting on you in the middle digit of that triple. Nothing else
changed, and this is a deliberate divergence from the Node capture.

`subscreen-node-library-frame-v1.txt` was re-recorded on 2026-10-05 so a
transient footer note carries the same mark on a subscreen as it does on the
dashboard.

Node ran two footer channels that could disagree and painted the dashboard one
with a danger `!` whatever it said, so "Restored 9 agents" and "Restoring 36
agents" both read as errors, while the *same* string on a subscreen rendered as
bare dim text with no mark at all. The channel is now typed -- progress, note,
failure -- and each kind has one rendering on every screen.

The frame differs by the "› " mark now prefixing the `Path:` line, and by that
line moving above the hint row. Node appended it after the hints, untruncated,
so a long message -- a plan path on an 80-column screen -- wrapped and pushed
the frame past its own row budget. The dashboard already put these above the
hints and truncated them; the subscreen now does the same. This is a deliberate
divergence from the Node capture.


`overlay-node-worktree-remove-frame-v1.txt` was re-recorded on 2026-10-04 to
correct copy that described something the route never did.

The graveyard confirm read "Offlines attached agents and moves the checkout to
the graveyard." `route_worktree_graveyard` touches no sessions at all: it stops
the worktree's services, kills their windows, and marks the worktree
graveyarded. Worse, an attached agent is the one thing that makes the route
*refuse* -- so the sentence promised precisely what it would not do. Sam read
it, pressed Enter, was refused, and reasonably concluded aimux was broken.

The frame now reads "Stops this worktree's services and moves the checkout to
the graveyard." The box is wider because the sentence is longer; nothing else
changed. This is a deliberate divergence from the Node capture, which recorded
the wrong sentence faithfully.

`dashboard-node-full-frame-v1.txt` and `dashboard-node-control-scribe-frame-v1.txt`
were re-recorded on 2026-09-10 to drop a duplicate `Main Checkout` card.

The Node capture drew the main checkout twice: once as the group with no path,
and once more from an orphan sweep over items whose `worktreePath` spelled the
main checkout out in full. Both frames contained `[1] Main Checkout · master`
and `[3] Main Checkout · master`, the second holding the same items. Sam hit the
session-side version of this on `~/cs/thegrand`, where six offline agents
appeared in both cards.

Because the fixture captured the bug, translating Node faithfully reproduced it
and this gate could not object. The re-recorded frames differ from the originals
by exactly that one card: the duplicate is gone and its single row moved into the
first card. Nothing else in either frame changed.
