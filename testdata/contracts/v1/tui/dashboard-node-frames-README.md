# Node whole-frame goldens

Captured from the Node dashboard renderer and used as literal parity gates.

## Recorded divergences

`subscreen-node-library-frame-v1.txt` was re-recorded on 2026-10-05 so a
transient footer note carries the same mark on a subscreen as it does on the
dashboard.

Node ran two footer channels that could disagree and painted the dashboard one
with a danger `!` whatever it said, so "Restored 9 agents" and "Restoring 36
agents" both read as errors, while the *same* string on a subscreen rendered as
bare dim text with no mark at all. The channel is now typed -- progress, note,
failure -- and each kind has one rendering on every screen.

The frame differs by exactly the "› " mark now prefixing the `Path:` line.
Nothing else changed. This is a deliberate divergence from the Node capture.


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
