# MonoCode

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, layout, and the checks to run before pushing.

## UI conventions

### Rolling text for labels that change in place

When a short, single-line label changes value while its element stays mounted, render it with `RollText` or `RollNumber` from `src/shared/ui/RollText.tsx` instead of a plain `<span>`. Examples: the model, effort, access mode, workspace mode, branch, and project chips; diff stats, ahead/behind counts, badges, usage percentages, and timers. The changed characters roll out and the new ones roll in; the shared start and end stay put.

- **Labels and choices** (a model name, a branch, a mode): `<RollText text={label} className="min-w-0 truncate" />`.
- **Counters, meters, and timers**: `<RollNumber text={count} />`. It follows the user's Settings > Appearance > Motion > "Animate changing numbers" toggle (`useAnimateNumbers` in `displayPrefs.ts`). `RollText` ignores that toggle.
- **Replace the label span itself**: pass the span's classes as `className`, so the label still truncates at rest. If the label sits inside a styled container like a badge, put `RollNumber` inside it and keep the container.
- **`text` must be a string or number**: build composite labels as one template string (`` `+${formatInteger(n)}` ``) rather than mixed JSX.
- **It handles reduced motion and the first render on its own**: don't add your own guards. `textContent` stays the plain label even mid-roll, so tests can still read it.

Don't use it when:

- **The element remounts on change** (keyed by the value, or swapped for a different element): the roll never runs.
- **Another text effect already owns the text**: `ParticleText` (sidebar session titles), `MonoWorkTicker`, or `Shimmer`. Shimmer's `background-clip: text` conflicts with the roll.
- **The text is multi-line or streamed.**
- **Code measures the label's width in a layout effect**: the width glides for `RESIZE_MS` after a change, so measure again once the roll lands. See `DiffStat` in `Sidebar.tsx`.

The timing and shape constants live in `src/shared/lib/rollText.ts`; tests are in `src/shared/lib/rollText.test.ts`.
