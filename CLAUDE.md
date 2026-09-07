# Notes for automated/scheduled sessions

This repo is monitored by a daily scheduled routine ("Todomap daily
monitoring") that looks for edge-case bugs, fixes them, and opens a PR.

**Before starting new work, check open pull requests first.** Do not pick an
edge case, sanitizer gap, or bug that overlaps in scope with what an
already-open, unmerged PR addresses (same function, same file, or the same
class of issue — e.g. "sanitizer doesn't validate field X"). Previous runs
have repeatedly mined the same seam (untrusted-data sanitizers in `app.js`,
`impact-effort/app.js`, `maps-index.js`, `home/home.js`) with narrowly
different framing, producing near-duplicate PRs that piled up unreviewed.

If there are open, unmerged PRs from previous runs, prefer surfacing that to
the user (they pile up unreviewed) over adding another PR in the same area.
Only open a new PR for a genuinely distinct edge case or bug.
