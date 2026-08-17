# PurgeWave Architecture

High-level map of how the pieces fit together. For *why* things work this way, `CLAUDE.md`'s
prose (real bugs found, spec tensions resolved) is authoritative — this file is the structural
skeleton. For exact file/line locations, see `llms.txt`. For requirements, `purgewave-spec.md`.

## Process split

Electron three-process model, strict boundary:

- **Main** (`src/main/`) — the only process that touches `fs`, spawns workers, or talks to the
  OS. Owns the in-memory `library`/`decisionsStore`/`settings` singletons (module-level `let` in
  `index.ts`) and all IPC handlers.
- **Preload** (`src/preload/index.ts`) — a typed `contextBridge` surface (`window.purgewave`).
  Pure pass-through to `ipcRenderer.invoke`; no logic.
- **Renderer** (`src/renderer/src/`) — pure UI (React 19 + Tailwind v4). Never imports `fs` or
  `electron` directly. Everything it knows about disk state comes through the IPC contract.

`contextIsolation: true`, `nodeIntegration: false` — the renderer has zero Node access outside
`window.purgewave`.

Plain-TypeScript logic modules (queue ordering, reconciliation, card building, stats, dormant
detection) have **no fs/Electron imports** and are unit-tested directly. The fs-touching
orchestration around them (scanning, disposal) is a thin layer that calls into those pure
functions.

## Data model

Two-file persistence under `app.getPath('userData')`, split by write frequency — see
`CLAUDE.md`'s Persistence section for the full rationale:

- `library.json` (`LibraryFile`) — cold. Paths, tags, fingerprints, folder art map. Rewritten
  only on scan (`library:scan`) or a field-level patch (`track:gain`, disposal, forget-dormant).
- `decisions.json` (`DecisionsFile`) — hot. Per-track status/timestamp/review-count keyed by
  track id, plus lifetime `stats`. Owned exclusively by `DecisionsStore`
  (`src/main/state/decisionsStore.ts`), debounced 2s, force-flushed on quit/session-end/dispose.
- `settings.json` (`Settings`) — tiny, rewritten on every settings change, merged over
  `createDefaultSettings()` on load so schema growth doesn't zero out old installs.

All three go through `writeJsonAtomic`/`readJsonWithFallback`
(`src/main/state/atomicWrite.ts`): temp file + fsync + rename, `.bak` rotation, per-path write
serialization so concurrent callers can't race the same file.

**Identity is content-derived, not path-derived.** Track ids are sequential (`t1`, `t2`, …,
`LibraryFile.nextId`), never reused. `fp` (fingerprint) is a truncated SHA-1 over a 64KB
mid-file read + size + rounded duration — deliberately mid-file so front-of-file ID3 edits don't
change it, and only recomputed when `size` changes. This is what makes reconciliation
rename/move-proof.

## Request flow: scan → reconcile → queue → cards

```
walk.ts (fs walk, skips quarantine dir)
  → scan.ts (4-worker pool: readTrack.ts + fingerprint.ts + artwork.ts per file)
    → reconcile.ts (pure: merges fresh reads against previous LibraryFile/DecisionsFile by fp)
      → library.json + decisions.json written (index.ts's library:scan handler)

queue.ts (pure: two fixed passes — unreviewed by birthtimeMs, then kept by reviewedAt)
  → session:start returns ordered track IDs only (not full records)
    → session:getCards windows in batches of 50 via cards.ts (pure: assembles a Card
      from Track + folders + decisions) + artwork.ts (resolves cached webp → data URL)
```

`reconcile()` is the load-bearing pure function: given previous state + this scan's fresh reads
(or `null` for an unreadable root), it produces the merged library/decisions or an abort signal.
A first-ever scan is just `reconcile(previousLibrary: null, ...)` — no separate code path.
Status-transition rules (missing→reappear→restored, trashed/moved→reappear→unreviewed, dormant
auto-prune after a year) all live here and are enumerated in `reconcile.test.ts`.

Every session start reruns this whole pipeline (`App.tsx`'s `startSession`), not just an
explicit rescan button — see CLAUDE.md for why, and the ~100ms measured cost that makes it cheap
enough to always do.

## Swipe session runtime

`SwipeScreen.tsx` holds the session state machine. Key design point: the *data model* index
(`currentIndex`, advanced synchronously) is decoupled from the *visual* exit animation (a
separate `exiting` list, cleared per-card on `onExitAnimationComplete`) — required because
`track:decide` must fire and the next card must be interactive within 100ms, while the departing
card's 220–320ms exit animation is still playing. `queue.ts`'s output is a fixed array indexed
by `currentIndex`, never spliced — undo is just `currentIndex--`.

`SwipeCard.tsx` does the pointer-drag physics (Framer Motion), delegates static layout to
`CardBody.tsx`, and reports commits via `onCommitted`. `useArtworkGradient.ts` derives the
card's background gradient from the artwork's dominant colors.

`useAudioEngine.ts` owns two `<audio>` elements ping-ponged for gapless-feeling crossfades, each
routed through its own `GainNode` on a shared `AudioContext`. Two separate ref-tracked indices —
`assignedIndexRef` (which slot the front card claimed, committed synchronously) and
`activeIndexRef` (which slot is actually making sound, committed after the real fade/play) —
exist specifically to avoid a race between the front-card-activation effect and the
next-card-prefetch effect; see CLAUDE.md for the exact bug this fixes. Audio is served over the
custom `track://<trackId>` protocol (`trackProtocol.ts`), registered privileged with Range
support so seeking into a large FLAC doesn't require downloading the whole file first.

## Disposal

`dispose.ts` runs all three modes (Recycle Bin / quarantine move / permanent delete) through one
shared loop — sidecar lookup (`sidecars.ts`), decision update, empty-folder cleanup
(`emptyFolders.ts`) are mode-independent; only the removal primitive differs
(`shell.trashItem` / `quarantineMove.ts`'s same-volume-rename-or-cross-volume-copy / `fs.unlink`).
Stops the whole batch on first Recycle-Bin failure rather than silently falling back to
permanent delete — the renderer gets back `needsPermanentPrompt` and decides. `restore.ts`
reverses a quarantine move back to the original path.

## Screens (renderer)

`App.tsx` is a single `View` union switched on `view.name` — no router. Flow:

```
library (home) → sessionPicker → swiping → review → library
                                     ↓
                                  restore, settings, stats (side branches, all return to library)
```

`resume` view is a one-time-per-launch interstitial shown only when `pendingDeletes > 0` at
startup (marks that survived across a quit).

## Theming

Semantic CSS custom properties on `data-theme`, defined in `styles.css` in three blocks
(`:root`, `prefers-color-scheme: dark` media query, `:root[data-theme='dark']`) — never
conditional Tailwind classes or JS-computed colors. `useTheme.ts` applies the attribute;
`resolveBackgroundColor()` in `index.ts` mirrors the two `--surface-base` values by hand so the
native `BrowserWindow` can paint the right color before first paint (no flash).

## What's pure vs. what touches the world

Pure (no fs/Electron import, directly unit-tested):
`reconcile.ts`, `queue.ts`, `cards.ts`, `stats.ts`, `dormant.ts`, `sidecars.ts` (partially —
does read the fs but is tested against real temp dirs, not mocked), `emptyFolders.ts` (same),
`keymap.ts`.

Orchestration (fs/Electron-touching, thinner, tested more by running the app than by unit test):
`scan.ts`, `walk.ts`, `readTrack.ts`, `artwork.ts`, `fingerprint.ts`, `dispose.ts`,
`quarantineMove.ts`, `restore.ts`, `trackProtocol.ts`, `decisionsStore.ts`, `atomicWrite.ts`,
all of `index.ts`.
