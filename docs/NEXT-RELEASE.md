# Next release

Changes on `dev` (and on the personal branches heading there) that are not in a release yet. Every issue branch adds
its changelog line and its QA block here in the same change, appending to the end of each list so the two personal
branches rarely conflict. A line marked "(on devJames)" or "(on devDavid)" has not reached `dev` yet; the PR into `dev` removes the marks. Entries travel
with their changes when they are promoted to `rc`. QA runs the checklist on the `rc` build of the release (the
release candidates published from `rc`, when the release has them); each candidate's `CHANGELOG.md` section is written
from this draft, but a candidate does not reset it. The file is
reset to its empty template once per stable release: the final release-prep PR resets it, and the reset comes back to
`dev` from `main` when `main` is merged back, keeping the entries of changes not released yet
([RELEASING](RELEASING.md#how-to-cut-a-release)).

## Changelog draft

### Added

### Changed

### Fixed

### Known issues

### Development

## QA checklist

Test on a `dev` build (`npm run dev` on `dev`). Tick an item when it behaves as described. A block marked (on devJames) or
(on devDavid) needs that branch until it is merged into `dev`.
