# PurgeWave — Requirements & Execution Plan

A Windows desktop app for triaging a local music library one track at a time. Each track appears as a card with metadata and an audio preview; the user swipes right to keep or left to mark for deletion. Nothing leaves the disk until the user reviews the marked set and confirms.

This document is the build brief for Claude Code. Sections 1–9 are requirements; section 10 is the execution plan with milestones and acceptance criteria.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Shell | Electron (latest stable) |
| UI | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS |
| Animation / gestures | Framer Motion (`drag` + velocity thresholds) |
| Tag reading | `music-metadata` (npm) |
| Recycle Bin | `shell.trashItem()` (Electron built-in) |
| Persistence | Two JSON files, no database |
| Packaging | `electron-builder`, NSIS installer, x64 |
| Updates | `electron-updater` against GitHub Releases |

Electron was chosen because every hard part of this app — decoding audio formats, reading ID3/Vorbis/MP4 tags, and moving files to the Recycle Bin — is a one-line library call rather than something that has to be built.

**Process split:** all filesystem work (scanning, tag reading, trashing, state file I/O) lives in the main process. The renderer is pure UI and talks to main only through the IPC contract in §7. `contextIsolation: true`, `nodeIntegration: false`, preload exposes a typed API via `contextBridge`.

**Keep the queue ordering, reconciliation diff, and status transitions in plain TypeScript modules with no Electron or `fs` imports.** They are the logic most worth unit-testing, and they should be testable without booting a window.

---

## 2. Core concepts

**Library** — the recursive contents of one user-chosen root folder, filtered to supported audio extensions.

**Index** — the app's record of every track in the library, including its review status. Persisted. Rebuilt incrementally on each launch.

**Queue** — the ordered sequence of tracks to present, derived from the index at session start (§5).

**Session** — one run of swiping, with an optional track limit chosen at the start. Ends at the limit, when the user stops, or when the queue empties.

**Mark** — a pending decision (`keep` or `delete`) recorded in the index. A `delete` mark is inert until the user confirms in the review screen, and survives across sessions until they do.

---

## 3. Persistence (no database)

### 3.1 Two files, split hot from cold

Everything lives under `app.getPath('userData')`, which resolves to `%APPDATA%\PurgeWave\`.

```
%APPDATA%\PurgeWave\
  library.json      Cold. Paths and metadata. Rewritten only on scan.
  decisions.json    Hot. Statuses and review timestamps. Rewritten on every swipe.
  settings.json     Tiny. Rewritten on settings change.
```

The split exists for write cost. The index is the large object — roughly 250 bytes per track, so 5 MB at 20,000 tracks and 50 MB at 200,000 — and re-serializing it on every swipe would stall the UI badly on a big library. The decisions file holds only the mutable fields and stays under a tenth of that size, so a swipe write is cheap no matter how large the library gets.

Track IDs are short sequential strings (`t1`, `t2`, …) assigned at first index, never reused, and stable across rescans. Do not use path hashes as keys — at 200k tracks the key strings alone would dominate the decisions file.

### 3.2 Schema

**library.json**

```jsonc
{
  "schemaVersion": 1,
  "musicRoot": "D:\\Music",
  "lastScanAt": "2026-08-16T09:12:44.000Z",
  "nextId": 4312,
  "scanSeq": 84,
  "folders": {
    "D:\\Music\\Artist\\Album": { "ids": ["t1", "t2", "t3"], "art": "cover.jpg" }
  },
  "tracks": {
    "t1": {
      "path": "D:\\Music\\Artist\\Album\\03 Track.mp3",
      "size": 8123456,
      "mtimeMs": 1699999999000,
      "birthtimeMs": 1699000000000,
      "title": "Track Name",
      "artist": "Artist Name",
      "album": "Album Name",
      "trackNo": 3,
      "year": 2019,
      "durationSec": 214.6,
      "bitrate": 320000,
      "format": "mp3",
      "hasArtwork": true,
      "artPath": "D:\\Music\\Artist\\Album\\cover.jpg",
      "replayGainDb": -7.2,
      "fp": "a3f1c9e28b4d7061",
      "lastSeenScan": 84
    }
  }
}
```

**decisions.json**

```jsonc
{
  "schemaVersion": 1,
  "d": {
    "t1": { "s": "keep", "r": 1723800000000, "n": 2 },
    "t2": { "s": "delete", "r": 1723800100000, "n": 1 },
    "t9": { "s": "trashed", "r": 1723700000000, "n": 1, "x": 1723800200000 },
    "t14": { "s": "moved", "r": 1723800300000, "n": 1, "x": 1723800400000,
             "movedTo": "E:\\Music Quarantine\\Artist\\Album\\05 Track.mp3" }
  },
  "stats": {
    "totalReviewed": 4218,
    "totalTrashed": 512,
    "totalMoved": 88,
    "bytesReclaimed": 3221225472,
    "bytesMoved": 1073741824,
    "sessionsCompleted": 37,
    "firstReviewAt": "2026-03-02T18:04:00.000Z"
  }
}
```

Keys are abbreviated deliberately: `s` status, `r` reviewedAt, `n` reviewCount, `x` trashedAt. Tracks absent from `d` are unreviewed — do not write entries for them.

`s` is one of `keep` | `delete` | `trashed` | `moved` | `missing`. There is no stored `unreviewed`; absence means unreviewed.

- `delete` is a pending mark. Only the review screen's confirm step turns it into `trashed`.
- `missing` means the file vanished from disk. The record is kept, along with the status it held in a `was` field, so the track's history survives if the file comes back (§3.5).
- `trashed` records what the app disposed of. Kept for lifetime stats, and excluded from the queue unless the file itself reappears.
- `moved` means the file was relocated to the quarantine folder (§6.7) and still exists. `movedTo` records where, which is what makes restoring possible.

### 3.3 Write strategy

Writes must be atomic and must never corrupt state on a crash or power loss:

1. Serialize to `<name>.json.tmp` in the same directory.
2. `fsync`, then `fs.rename()` over the target (atomic on NTFS).
3. Keep the previous version as `<name>.json.bak`, rotated on each successful write.

Debounce `decisions.json` to once per 2 seconds, and force a flush on: session end, deletion confirm, and `before-quit`. The renderer must never await a flush — see §3.7. Serialize writes through a queue so a slow flush can't overlap the next one. `library.json` is written once at the end of a scan.

On load: if a file fails to parse, fall back to its `.bak` and warn. If both fail, preserve the corrupt file as `<name>.corrupt-<timestamp>.json` and start fresh — never overwrite it. A lost `library.json` costs a rescan; a lost `decisions.json` costs review history, so warn loudly before proceeding in that case.

### 3.4 Identity: fingerprint, not path

**A track's identity is its content, not its location.** Paths are an attribute that can change; the fingerprint is what persists.

```
fp = sha1( 64KB read at floor(size / 2)  ||  size  ||  round(durationSec) )
```

Truncate to 16 hex chars. Read from the **middle** of the file, never the start: ID3v2 tags sit at the front, so a head-based hash would change every time the user edits a tag and would defeat the entire purpose.

Compute `fp` when a file is first indexed, and recompute only when `size` changes. A tag edit changes `mtimeMs` but not `size`, so it costs nothing. The extra 64KB read is negligible next to tag parsing.

Maintain an in-memory `fp → trackId` map during a scan. Collisions are possible in principle (two byte-identical files, i.e. genuine duplicates); when two live paths share a fingerprint, keep them as separate IDs and mark both `dupOf` the first. Do not merge them.

### 3.5 Reconciliation on rescan

**Guards first.** Before diffing, abort the entire reconciliation and surface an error if:

- the root path doesn't exist or isn't readable — a disconnected external drive must never be read as a mass deletion; or
- the scan returned zero audio files while the index holds more than zero.

The quarantine destination (§6.7), if configured, is excluded from every walk regardless of where it sits.

In both cases leave all state untouched and show a "Can't reach your music folder" screen with retry and change-folder actions. This guard is more important than anything else in this section.

Otherwise, walk the root and diff:

- **Fingerprint in index, path unchanged** — keep status. If `size` or `mtimeMs` changed, re-read tags and refresh metadata, but **do not reset review status**; editing a tag isn't a reason to re-judge a track.
- **Fingerprint in index, path changed** — a move or rename. Update the path on the existing ID, keep status, review count, and timestamps. This handles single renames and whole-tree reorganizations identically, with no ambiguity and no heuristic.
- **Fingerprint in index, path gone, no new location** — set status `missing`. Keep the record and its prior status in a `was` field.
- **Fingerprint absent from index** — new entry, unreviewed.
- **A `missing` fingerprint reappears anywhere in the tree** — restore it. Set the new path and return it to the status in `was`. A file that comes back is the same file, with its history intact.
- **A `trashed` fingerprint reappears** — the user disposed of it and then restored it from the Recycle Bin, which is a deliberate reversal. Return it to the queue as **unreviewed** rather than restoring the old decision, and keep its `n` count so the card can note it's been seen before.
- **A `moved` fingerprint reappears inside the library** — the user put it back by hand rather than through the restore action. Treat it exactly like a returning `trashed` file: unreviewed, `n` preserved, `movedTo` cleared. The quarantine folder itself is never scanned, so this only triggers on a genuine manual restore.
- **Path in index, outside the current `musicRoot`** — nothing special. Location is not identity. If the fingerprint wasn't found in this scan, it becomes `missing` like any other absent file; if it was found, it's already been rebased. Never prune on the basis of a path falling outside the root.

Record `lastSeenScan` (the scan sequence number) on every entry matched during a scan. This is what makes the dormancy cleanup in §3.6 possible, and it costs one integer per track.

### 3.6 Changing the library root, and dormant records

**Changing the root never destroys records.** There is no threshold, no heuristic, and no automatic pruning anywhere in the app. Point PurgeWave at a new folder and it simply scans it: fingerprints it recognizes are rebased onto their new paths with full history, fingerprints it doesn't are added as unreviewed, and everything from the old root that didn't turn up goes `missing`.

This falls out of §3.5 with no extra logic, and it makes the ambiguous cases safe by construction:

- **The library moved** — every fingerprint matches, everything rebases, nothing is lost.
- **You pointed at a subfolder** to triage one genre — the rest of the library goes dormant as `missing` and revives untouched the moment you point back at the parent.
- **A genuinely different library** — the old records sit dormant, costing a few hundred KB and nothing else.
- **The drive was unplugged** — caught by the §3.5 guard before any of this runs.

Getting this wrong in the destructive direction costs the user years of review history and cannot be undone; getting it wrong in the permissive direction costs disk space measured in kilobytes. The asymmetry decides it.

**Cleanup is manual and explicit.** In settings, offer **"Forget dormant tracks"**: drops `missing` records not seen in the last N scans, defaulting to 20, stating the exact count and how long it's been since each was last seen. Require confirmation. Also drop `missing` records automatically once they haven't been seen for a full year — long enough that a forgotten external drive has had every reasonable chance to reappear.

Never forget `trashed` records this way. They're small, and the lifetime stats in §6.8 depend on them.

### 3.7 Performance budget

Swiping is the app's entire loop and it happens hundreds of times per session, so latency here matters more than anywhere else. **The card must move the instant the gesture releases, and audio must be playing within a quarter second.** Design to these numbers and treat them as acceptance criteria, not aspirations:

| Action | Budget |
|---|---|
| Gesture release → next card interactive | < 100 ms |
| Next card → audio audible | < 250 ms |
| Session start (any library size) | < 500 ms |
| Frame rate during drag | 60 fps, no dropped frames |

Five rules follow from that, and each one closes a specific hole:

**1. Optimistic UI. Never await the main process to animate.** On release, run the exit animation and advance the stack immediately, then fire `track:decide` without awaiting it. The write is not allowed to be in the visual path. If it ever fails, surface it as a non-blocking toast; it won't, because the write itself is debounced.

**2. Never send the whole queue over IPC.** `session:start` returns an ordered array of track IDs only. The renderer requests card data in windows of 50 via `session:getCards`, keeping the current window plus the next one in memory. A 200k-track ordered ID list is about 1.5 MB; the full objects would be 50 MB and would freeze the app on structured-clone alone.

**3. Two audio elements, ping-ponged.** Maintain an A/B pair. While card *n* plays on A, card *n+1* is already loaded and seeked to its 20% offset on B, muted and paused. On swipe, swap: unmute B with the 1-second fade, and start preparing card *n+2* on A. The user never waits for a load because the load already happened.

Prefetch depth is 2 — one card ahead is enough to hide the latency, and more wastes I/O on tracks that may never be seen.

**4. The `track://` handler must support HTTP Range requests.** Return `206 Partial Content` with correct `Content-Range` and `Accept-Ranges: bytes` headers. Without this, seeking to 20% of a large FLAC transfers the entire file first. This is the single biggest latency risk in the app — verify it explicitly with a 40 MB file.

Range support solves the transfer but not the *seek index*. Translating a timestamp to a byte offset is instant for a FLAC carrying a SEEKTABLE block, but files without one make the demuxer binary-search for the frame across several small ranged reads, and `.m4a` files with a trailing `moov` atom need a tail read before any seek is possible. On local storage this is milliseconds; on a NAS it can reach a few hundred. Handle it rather than assume it:

- Always wait for `loadedmetadata` before setting `currentTime`. Setting it earlier silently does nothing.
- After seeking, confirm the position took. If `seekable` is empty or the seek doesn't land, fall back to playing from the start and mark the track so subsequent plays skip the attempt.
- Time the prepare step. If it exceeds 400 ms, record it on the track record and reduce that file's start offset to 0 next time — a fast start from the beginning beats a slow start from the middle.
- If the user swipes before the next element is ready, do not stall the card. Advance immediately, show the card silently, and begin playback when it becomes available. **Visual responsiveness always wins over audio punctuality.**

**5. Precompute everything the card displays.** Nothing on a card may require a filesystem read or an index scan at display time:

- **Album context** comes from the `folders` map built at scan time, which is a direct lookup. Marked-sibling counts come from the in-memory decisions map, which is already resident.
- **Artwork** is extracted once at scan time into `%APPDATA%\PurgeWave\art\<fp>.webp`, resized to 600px on the long edge. Cards read that file, never the original. Skip re-extraction when the cache entry exists and the fingerprint is unchanged.
- **Loudness** uses the cached `replayGainDb` when present; measurement only happens on a track's first play.

Additionally: keep the rendered card stack to 3 nodes maximum, animate only `transform` and `opacity` so the compositor handles it, and keep `backdrop-filter` off the moving card — it forces a repaint per frame and is the usual culprit when a swipe feels heavy.

### 3.8 Scan performance

Scanning must not block the UI. Run the walk in the main process, emit progress every 250 files, and read tags in a pool of 4 concurrent workers. Show a progress screen with a count and a cancel button on first scan; subsequent rescans of an unchanged tree should complete in a couple of seconds because tags are only re-read when `size`/`mtimeMs` moved.

---

## 4. Supported files

All audio in the tree enters the queue — no duration filter, no attempt to exclude audiobooks, podcasts, or long DJ mixes. If a 90-minute set is in the music folder, it's a candidate for triage like anything else.

Extensions: `.mp3`, `.flac`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.wav`, `.wma`, `.aiff`, `.alac`.

Chromium cannot decode `.wma`. Index those files so they can still be reviewed and deleted, but disable preview and say why on the card. Same treatment for any file that fails to decode.

Duplicate detection is out of scope. Two copies of the same track under different paths are two independent entries and may both appear.

---

## 5. Queue ordering and sessions

### 5.1 Ordering

Two passes, in this order:

1. **Pass 1 — unreviewed.** Every track with no decisions entry, sorted by `birthtimeMs` ascending (oldest file first), tiebroken by path.
2. **Pass 2 — previously kept, least recently reviewed first.** Every track with status `keep`, sorted by `r` (reviewedAt) ascending, tiebroken by `birthtimeMs`. Only entered once pass 1 is exhausted.

Re-confirming a track in pass 2 updates `r` and increments `n`, sending it to the back of the line. Since the queue is fixed at session start, a re-confirmed track cannot resurface in the same session.

Tracks with status `delete` are excluded — they're marked and waiting in the review screen. `trashed` and `missing` are excluded permanently.

On Windows, `birthtimeMs` is the file creation time, which for copied-in files is the date they landed in the folder. That matches "date added" closely enough; do not derive it from tags.

When the app enters pass 2, show a one-time interstitial: everything new has been reviewed, and it's now re-showing keepers starting with the ones judged longest ago. Dismissible, and clearly not an error state.

### 5.2 Session length

At the start of every session, ask how many tracks to review: **10, 25, 50, 100, or unlimited**. Remember the last choice as the default. This is a single screen with five buttons, not a settings-buried option — it's the moment that sets the intent for the session.

On reaching the limit, go straight to the review screen with a completion note. "Unlimited" ends when the user stops or the queue empties.

Show remaining count in the swipe chrome as `12 left in this session` for a capped session, or `147 of 3,204` for an unlimited one.

---

## 6. Screens and behavior

### 6.1 First run

Empty state with a single action: choose the music folder (`dialog.showOpenDialog`, `openDirectory`). Persist the choice. Changing the root later triggers a full rescan. It never discards records: matching files rebase, the rest go dormant (§3.6).

### 6.2 Unfinished deletions on launch

`delete` marks survive across sessions and are never silently discarded. If any exist on launch — checked after the rescan, so counts are accurate — go to a resume screen before anything else:

> **12 files are still marked for deletion.** They're from your last session and still on disk.
> [Review them now] [Keep swiping]

"Keep swiping" goes to the session-length screen with the marks intact, and the count stays visible in the swipe chrome. Show this once per launch. If the rescan found some marked files now `missing`, say so here and drop them quietly rather than failing on them later.

### 6.3 Swipe screen

The card shows: title, artist, album, duration, year, format and bitrate, file size, date added, and artwork. Fall back to the filename when tags are missing, and label it as a filename so the user knows what they're looking at.

**Album context.** When other tracks from the same album folder are present in the library, show a quiet line — `Track 3 of 12 · Abbey Road` — plus how many of its siblings are already marked for deletion, if any. This is informational only. There is no album-level action in v1; the point is to make it obvious when a card is part of something intact.

**Pass 2 cards** additionally show the last review date and review count. That context is the whole reason the track is back.

Persistent chrome: session progress, kept and marked counts, undo, autoplay toggle, volume, and "End session".

### 6.4 Controls

**Be generous.** People arrive with habits from Tinder, from media players, from games, from file managers, and they'll try whatever their hands already know. Every reasonable guess should work. This is cheap to allow because a delete mark is reversible until the review screen confirms it — nothing an errant keypress does is permanent, which is exactly why the input surface can afford to be wide.

**But there is still no skip.** Every card resolves to keep or discard; the point of the app is that it forces a call. No snooze, no "decide later", no neutral gesture. Vertical drag is inert. Undo exists for misfires, not indecision.

#### Full mapping

| Intent | Inputs |
|---|---|
| **Discard** (mark for deletion) | Drag left · `←` · `A` · `Delete` · click the card's left third · on-screen Discard button |
| **Keep** | Drag right · `→` · `D` · `Enter` · click the card's right third · on-screen Keep button |
| **Play / pause** | `Space` · click the card's center third |
| **Replay from the preview start** | `↑` · `R` |
| **Undo** | `Ctrl+Z` · `Backspace` · `U` · mouse button 4 (back) |
| **End session** | `Esc` |
| **Volume** | `+` / `-` · scroll wheel over the volume control |

`↓` is unbound. `Backspace` maps to undo rather than discard because the browser-back reflex is stronger than the delete-key reflex, and `Delete` covers the latter.

#### Click zones

Split the card into thirds: left discards, center toggles playback, right keeps. This must not fire accidentally, so:

- **Distinguish click from drag.** Suppress the click if the pointer moved more than 5px or the pointer was down for more than 250 ms. A drag that snaps back is not a click.
- **Reveal on hover.** Hovering a side zone shows a soft tint in `--keep` or `--discard` and switches the cursor, so the zones are discoverable rather than surprising. The center zone shows a play/pause glyph.
- **Make it optional.** A setting disables side-click decisions for anyone who finds it twitchy, leaving the whole card as play/pause. On by default.

#### Behavioral rules

These apply to every input path equally:

- **Ignore key repeat.** Check `event.repeat` and drop it. Holding `A` down must mark exactly one file, not forty.
- **One decision per card.** Once a card has been decided, further input targets the next card, never the departing one.
- **Queue up to two decisions.** A fast user can out-run the 250 ms exit animation. Buffer the extra input and apply it rather than dropping it — dropped decisions are worse than a momentarily busy screen.
- **All paths animate identically.** Keyboard and button decisions run the same exit with a synthetic velocity (§9.3). A keyboard user and a mouse user should see the same app.
- **Nothing fires while a dialog or interstitial is open.** Scope the key handler to the swipe screen.
- Register `navigator.mediaSession` handlers so hardware media keys control playback rather than leaking to whatever else is running.

#### Discoverability

Show a dismissible hint strip on the first session — the three or four primary bindings, not the full table — and a `?` key that opens the complete list. Persist dismissal.

Drag commits past 35% of card width or a flick velocity over 500 px/s; full motion detail is in §9.3.

The decision writes to state immediately, so a crash mid-session loses nothing.

#### Undo

**Undo brings the card back for a fresh decision.** It isn't a quiet correction to a log somewhere — the previous track returns to the screen, exactly as it was, and waits to be judged again.

What happens on undo:

- The card animates back in from the direction it left, reversing its exit. This is the one place motion should read as rewinding rather than advancing.
- Its stored decision reverts to what it was before: absent for a pass 1 track, or `keep` with the prior `r` and `n` restored for a pass 2 track. The `n` count must not be left incremented.
- The card that was on screen returns to the front of the remaining queue, unjudged. Nothing is skipped.
- Session counters roll back, including consumption against a session limit. Undoing three cards in a 25-track session leaves 3 more to review, not fewer.
- The preview restarts and plays as if the card were arriving normally, respecting the autoplay setting.

The stack is session-scoped and holds at least 20 decisions. Repeated undo walks back through them in order. Once the stack is empty, the undo control disables rather than silently doing nothing.

Undo is deliberately not available after disposal — once files are in the Recycle Bin, Windows owns the restore. Say so plainly if someone tries.

There is no redo. Re-deciding the card is the redo.

### 6.5 Audio preview

Autoplay is **on by default** and toggleable.

- Start playback at 20% into the track. Make this a named constant.
- **Fade in over 1 second**, fade out over 200 ms on card exit. Abrupt starts are unpleasant when swiping quickly.
- Stop the outgoing track before starting the incoming one. Never overlap.
- Prefetch one card ahead on a second audio element and swap on swipe (§3.7). Prefetch depth is 2 — never the whole queue.
- No scrubbing or seeking in v1. The fixed excerpt is the discipline.
- A file that fails to decode must not break the flow: inline "Can't preview this file" on the card, still swipeable, reason logged.

**Volume normalization** — on by default, toggleable. Two-tier approach:

1. If the file carries a ReplayGain tag, `music-metadata` exposes it. Use it, store as `replayGainDb`, apply via a Web Audio `GainNode`.
2. Otherwise measure RMS with an `AnalyserNode` over the first 400 ms of the preview window and derive a correction toward a target loudness. Clamp to ±12 dB and apply the change inside the 1-second fade-in, so the adjustment is inaudible.

Cache the computed value in `library.json` so it's measured once per file, not once per view.

**Artwork** — embedded art first. If absent, look in the track's own directory for `cover.*`, `folder.*`, `front.*`, or `album.*` (jpg/jpeg/png/webp) in that order, and cache the resolved path on the track record. If neither exists, render a generated placeholder derived from the artist name rather than a generic music-note icon.

Serving local files to the renderer: register a custom protocol in the main process with `protocol.handle('track', ...)` that streams the file after validating the requested path is inside the library root. Do not disable `webSecurity`, and do not use raw `file://` URLs.

### 6.6 Review screen

Reached from "End session", the session limit, an emptied queue, or the launch resume screen. Two lists: **Keeping** and **Deleting**.

Every row can be flipped to the other list before confirming. Show total count and total size for the delete list — reclaimed space is the main thing the user wants to see here. Rows show title, artist, and path.

Two exits: "Back to swiping" (resumes the queue at the current position, and extends a capped session) and the confirm action, whose label matches the current disposal mode: "Move 12 files to Recycle Bin", "Move 12 files to Quarantine", or "Permanently delete 12 files".

### 6.7 Deletion

Disposal mode is a setting (§8), defaulting to Recycle Bin. On confirm, show a dialog stating the exact count, total size, and destination, then process files sequentially with progress.

**Recycle Bin mode** — `shell.trashItem(path)` per file. On success, set status `trashed`, record `x`, add to lifetime stats.

**If trashing fails** because the volume has no Recycle Bin (common on NAS shares, some removable drives) or the file is locked, **stop and ask**. Do not fall back silently:

> **This drive has no Recycle Bin.** 12 files can't be moved there. Deleting them here removes them permanently — Windows can't restore them.
> [Delete permanently] [Skip these files]

"Skip" leaves the files on disk with their marks intact. This prompt appears once per batch, not once per file.

**Move-to-folder mode** — relocates marked files to a destination folder the user picks, leaving them fully intact and playable. This is the gentlest of the three modes and the right choice for anyone who wants a holding pen rather than a deletion.

- **Destination.** Chosen once in settings via a directory picker and remembered. Prompt for it the first time the mode is selected; don't let the mode be active without one.
- **The destination must be excluded from scanning**, always and automatically, whether or not it sits inside the library root. Without this, moved files are re-indexed and march straight back into the queue. If the user picks a folder inside the library root, allow it but say plainly that it will be skipped during scans.
- **Mirror the library's structure.** A file at `D:\Music\Artist\Album\03 Track.mp3` lands at `<dest>\Artist\Album\03 Track.mp3`. Creating the subfolders costs nothing, prevents collisions between same-named tracks, and makes a manual restore a single drag.
- **Same volume** — use `fs.rename`, which is instant regardless of file size. **Across volumes** — `rename` throws `EXDEV`, so fall back to copy, verify the written size matches, and only then remove the source. Never remove a source before its copy is verified.
- **Collisions.** If the destination path is taken, compare fingerprints. Identical file: the move already happened, so remove the source and record it as done. Different file: append ` (2)`, ` (3)`, and so on.
- On success, set status `moved`, record `x` and the destination in `movedTo`.

**Restoring moved files.** Because the files still exist and their origins are recorded, offer **"Restore moved files"** in settings: lists everything with status `moved`, and puts selected files back at their original paths, recreating folders as needed and reverting status to `keep`. If something now occupies the original path, skip that file and report it. This is the payoff for the mode existing — make it easy to find.

**Space is not reclaimed by a move.** Moving within the same drive frees nothing at all. Report it honestly as "12 files moved, 340 MB" rather than "340 MB reclaimed", and count it separately from `bytesReclaimed` in lifetime stats.

**Permanent mode** — `fs.unlink`, but only ever reached through either the explicit setting or the prompt above. There must be no third code path that deletes a file.

**Sidecar files** — on by default. When a track is disposed of, take its companions with it:

- **Same-basename files** in the same directory — `.lrc`, `.cue`, `.txt`, `.nfo`, and images. These belong to that track alone and always go with it.
- **Album artwork** (`cover.*`, `folder.*`, `front.*`, `album.*`) — goes when the track being removed is the **last remaining audio file in its directory**. Art attached to an album follows the album out; it is not taken while siblings still need it.

Embedded artwork needs no handling — it lives inside the file and leaves with it.

Sidecars follow their track to the same destination, including into the quarantine folder, and are counted separately in the summary.

**Empty folders** — on by default. After a batch, walk upward from each affected directory and remove any that are now empty or contain only leftover `.m3u`/`.nfo` files, stopping at the library root. Album art will usually already have gone with the last track. Removed folders go to the Recycle Bin when that mode is active, and are deleted outright in the other two. Report the count in the summary.

Afterward, show a summary phrased for the active mode: files disposed, space reclaimed **or** space moved, sidecars taken, folders removed, and anything that failed with its reason and a retry action. Flush state immediately.

### 6.8 Stats

A lifetime stats screen, reachable from the main chrome, reading `decisions.stats`:

- Tracks reviewed, kept, and deleted, with a keep rate
- Space reclaimed, and space moved to quarantine, reported separately
- Library composition: total tracks, how many still unreviewed, percentage triaged
- Sessions completed and reviewing since date
- A simple bar chart of tracks reviewed per week

Keep it to one screen and derive everything from counters already maintained. No new tracking infrastructure.

---

## 7. IPC contract

Define these in a shared TypeScript types file used by both processes.

| Channel | Direction | Payload → Result |
|---|---|---|
| `library:chooseRoot` | invoke | `void` → `{ path } \| { cancelled: true }` |
| `library:getState` | invoke | `void` → `{ root, counts, settings, pendingDeletes }` |
| `library:scan` | invoke | `{ force?: boolean }` → `{ added, updated, missing, pruned, total }` |
| `library:scanProgress` | main→renderer | `{ scanned, total, currentPath }` |
| `session:start` | invoke | `{ limit: number \| null }` → `string[]` (ordered track IDs per §5.1) |
| `session:getCards` | invoke | `{ trackIds: string[] }` → `Card[]` (windowed, max 50) |
| `track:decide` | invoke | `{ trackId, decision: 'keep' \| 'delete' }` → `{ ok }` — fire and forget, never awaited in the swipe path |
| `track:undo` | invoke | `{ trackId, previous }` → `{ ok }` |
| `track:gain` | invoke | `{ trackId, replayGainDb }` → `{ ok }` (cache measured value) |
| `review:getMarked` | invoke | `void` → `{ keep: Track[], delete: Track[], deleteBytes }` |
| `review:confirmDispose` | invoke | `{ trackIds, mode }` → `DisposeResult` |
| `restore:list` | invoke | `void` → `Track[]` with status `moved` |
| `restore:run` | invoke | `{ trackIds }` → `{ restored, failed: {path, reason}[] }` |
| `review:confirmPermanent` | invoke | `{ trackIds }` → `DisposeResult` (only after the §6.7 prompt) |
| `settings:update` | invoke | `Partial<Settings>` → `{ ok }` |
| `stats:get` | invoke | `void` → `Stats` |

`DisposeResult` is `{ mode, disposed, sidecarsDisposed, foldersRemoved, bytesReclaimed, bytesMoved, needsPermanentPrompt: string[], failed: {path, reason}[] }`. Exactly one of `bytesReclaimed` and `bytesMoved` is meaningful per batch, decided by `mode`.

Validate every path crossing IPC against the library root before acting on it.

---

## 8. Settings

| Setting | Default | Notes |
|---|---|---|
| Autoplay preview | On | |
| Volume | 0.8 | |
| Normalize volume | On | ReplayGain tag, else measured |
| Disposal mode | Recycle Bin | Or move to a folder, or permanent delete |
| Quarantine folder | — | Required when disposal mode is "move"; always excluded from scans |
| Restore moved files | — | Puts quarantined files back at their original paths |
| Side-click decisions | On | Click card thirds to keep or discard |
| Remove sidecar files | On | Same-name companions always; album art with the last track in a folder |
| Remove empty folders | On | Stops at library root |
| Music folder | — | Changing it never discards records (§3.6) |
| Forget dormant tracks | Off (manual) | Drops `missing` records unseen for 20+ scans |
| Theme | System | Light, Dark, or System |
| Check for updates | On | |

The disposal mode row needs a plain-language note under it: moving to a folder keeps files intact and reversible, the Recycle Bin lets Windows restore them, permanent delete does not, and drives without a Recycle Bin will prompt before anything is destroyed. Write it in the interface's own voice, not as a legal warning.

---

## 9. Visual direction and non-goals

### 9.1 Themes

**Both a light and a dark theme are required, and both are first-class.** The setting offers Light, Dark, and System, defaulting to System and following `prefers-color-scheme` live when set to it.

Implement as semantic CSS custom properties on a `data-theme` attribute at the root — never conditional Tailwind classes scattered through components, and never a JS-computed color anywhere:

```css
:root[data-theme="dark"] {
  --surface-base:   /* deepest background */
  --surface-raised: /* card */
  --surface-overlay:/* dialogs, popovers */
  --text-primary:   /* title */
  --text-secondary: /* artist */
  --text-muted:     /* technical metadata */
  --border-subtle:
  --accent:         /* the app's own color */
  --keep:           /* right-swipe affirmative */
  --discard:        /* left-swipe negative */
}
```

Rules that keep this honest:

- **Design the light theme; don't invert the dark one.** Inversion produces grey mud. Light needs a genuinely different treatment — shadows carry elevation where dark uses surface lightness, and the accent usually needs to darken and saturate to hold its weight against white.
- **Both themes must hit WCAG AA** for every text role, including over artwork-derived backgrounds. Test both; passing one says nothing about the other.
- **Artwork treatment differs per theme.** A blurred album-art background needs a dark scrim in dark mode and a light scrim with reduced artwork opacity in light mode, or the metadata becomes unreadable over pale covers.
- **No flash on launch.** Read the theme preference before the window is shown and set `BrowserWindow`'s `backgroundColor` to match, so there's no white blink on a dark-theme start.
- Keep and discard colors must remain distinguishable in both themes, and must never be the only signal — position, icon, and label carry the meaning too.

### 9.2 The card

The card is the entire app; everything else recedes. Before building, consult the `frontend-design` skill and produce a token system — 4–6 named colors per theme, a display face and a body face, a type scale — and state it before writing code.

Structure:

- One card, centered, portrait-ish, with the next card visible beneath it at reduced scale so the stack has depth. Three rendered nodes maximum (§3.7).
- Artwork is the hero: large, square, top-weighted, with the file's own art doing the visual work rather than app chrome.
- Metadata is hierarchical, not tabular. Title dominant. Artist secondary. Album and year tertiary. Format, bitrate, size, and date added small and quiet at the base, present for when they matter and ignorable when they don't.
- Album context (§6.3) and the pass-2 review history sit in that quiet zone, not competing with the title.
- Where art is missing, the generated placeholder should feel deliberate — derived from the artist name — rather than a grey box with a music note.

Draw the aesthetic from physical audio media and hi-fi equipment rather than generic dashboard UI. Avoid the current AI-design defaults: cream with a terracotta accent, near-black with a single acid-green accent, and the hairline-rule broadsheet layout.

### 9.3 Motion

Framer Motion's defaults feel mushy for this. Specify the physics.

**Drag.** The card tracks the pointer 1:1 on x, with a small y drift allowed for naturalness but no y-axis consequence. Rotation is proportional to horizontal offset, capped at 8°, pivoting from below the card so it feels hinged rather than spun. Vertical drag is inert (§6.4).

```js
// card follow
drag="x"
dragElastic={0.7}
dragConstraints={{ left: 0, right: 0 }}
dragTransition={{ bounceStiffness: 500, bounceDamping: 40 }}
```

**Intent feedback during drag.** Beyond ~15% displacement, fade in a keep or discard indicator whose opacity tracks distance, and tint the card edge toward `--keep` or `--discard`. The user should know the outcome before releasing. At the commit threshold, a subtle scale pulse (1.0 → 1.02) marks the crossing so the threshold is felt, not guessed.

**Exit.** Velocity-aware: carry the release velocity into the exit so a hard flick leaves fast and a slow push leaves gently. Target 220–320 ms to fully clear, translating 1.4× viewport width with rotation continuing and opacity falling to 0 over the last 40%.

**Stack advance.** The card beneath rises `scale 0.94 → 1` and `y +12px → 0` on a spring — `stiffness: 400, damping: 32, mass: 0.8` — starting simultaneously with the exit, not after it. Sequencing these is the single most common way swipe UIs end up feeling slow.

**Snap-back.** Below threshold, return with `stiffness: 600, damping: 30`. Snappier than the advance; a rejected gesture should feel like a rubber band, not a slow drift.

**Entry.** New cards enter the bottom of the stack with opacity only. No slide, no scale — motion down there competes with the card being judged.

**Undo.** The returning card reverses its own exit: it re-enters from the side it left, rotation unwinding, on a slightly softer spring than the exit (`stiffness: 350, damping: 30`). The card that was on screen drops back into the stack beneath it. This is the only motion in the app that should read as rewinding, and that legibility is the point — the user needs to see that the app went backwards.

**Button and keyboard decisions** run the same exit animation with a synthetic velocity, so all three input methods look identical. Never let the button path feel different from the gesture path.

**Reduced motion.** With `prefers-reduced-motion`, replace exits with a 150 ms cross-fade, drop rotation entirely, and keep the tint feedback — the feedback is information, not decoration.

Everything above animates `transform` and `opacity` only. No `backdrop-filter` on the moving card (§3.7).

Copy is plain and active. The button says "Move 12 files to Recycle Bin", and the toast says "Moved 12 files to Recycle Bin". Empty and error states explain what happened and what to do, without apologizing.

### 9.4 Non-goals

Explicitly rejected, not deferred: a skip or "decide later" action (§6.4), preview scrubbing (§6.5), and any automatic pruning of review history (§3.6).

Not in v1: editing tags, playlists, multiple library roots, duplicate detection, album-level bulk actions, undo after disposal (Windows owns that), cloud sync, mobile, and any audio analysis beyond tags and loudness.

---

## 10. Execution plan

Build in order. Each milestone is independently runnable; do not start the next until the acceptance criteria pass.

### M1 — Skeleton
Electron + Vite + React + TypeScript, `contextIsolation` on, typed `contextBridge` preload, one round-trip IPC call.
*Accept:* `npm run dev` opens a window rendering a value from the main process.

### M2 — Folder choice and scan
Directory picker, recursive walk with the §4 extension list, tag reading via `music-metadata` with 4-way concurrency, fingerprinting, the `folders` map, the artwork thumbnail cache, progress events, and `library.json` written atomically with `.bak` rotation.
*Accept:* a folder of 1,000+ files produces a valid index with correct titles, durations, `birthtimeMs`, and fingerprints, UI responsive throughout. Killing the app mid-scan leaves parseable files.

### M3 — Queue, reconciliation, and state split
Both files per §3, queue builder per §5.1, session limits per §5.2, fingerprint identity per §3.4, and the guards, diff, and relocation logic of §3.5–3.6.
*Accept:* unit tests cover pass 1 ordering by `birthtimeMs`, pass 2 ordering by `reviewedAt`, and the pass transition. Reconciliation tests must cover: a renamed file keeping its status; a file moved to a different folder keeping its status; the entire tree reorganized at once with every status preserved; a tag edit changing `mtimeMs` without changing the fingerprint or the status; a deleted file becoming `missing`; that same file restored and returning with its prior status; a `trashed` file restored and returning as unreviewed; an unreadable root aborting the diff with zero mutations; a zero-file scan aborting the diff; a root change rebasing every matching fingerprint; pointing at a subfolder leaving the siblings dormant rather than pruned and reviving them when the parent is reselected; and no code path pruning a record without an explicit user action. A swipe write must not rewrite `library.json` — assert this.

### M4 — Swipe UI
Card, Framer Motion drag with threshold and velocity, exit animation, the full §6.4 control surface including click zones and the hint strip, undo stack, session counters, album context line. No audio yet.
*Accept:* every binding in the §6.4 table works and produces an identical exit; holding a key marks exactly one file; a drag that snaps back does not register as a click; two decisions entered faster than the animation are both applied; 50 consecutive swipes record correct statuses; swiping as fast as the animation allows never drops a frame or a decision, verified against a 200k-entry synthetic index; undo returns the card to screen, restores pass 2 timestamps and review counts exactly, rolls back the session limit, and walks back 20 deep before disabling; reduced-motion cross-fades; vertical drag does nothing.

### M5 — Audio preview
`track://` protocol with root validation, autoplay toggle, 20% start, 1s fade-in, single-track discipline, two-tier normalization with caching, artwork fallback chain, graceful decode failure.
*Accept:* mp3, flac, m4a, ogg, wav, aiff all preview; `.wma` shows the disabled state; rapid swiping never overlaps audio; the `track://` handler returns `206` with a correct `Content-Range` for a ranged request; a 40 MB FLAC begins playing at its 20% offset in under 250 ms without transferring the whole file; a FLAC stripped of its SEEKTABLE still starts, falling back to offset 0 if the seek fails rather than hanging; swiping faster than prefetch advances the card silently instead of stalling; a quiet track and a loud track played back to back sit within a few dB of each other.

### M6 — Review and disposal
Launch resume screen, review screen with both lists, flip rows, size totals, confirm dialog, all three disposal modes, sequential `shell.trashItem`, the no-Recycle-Bin prompt, quarantine moves with cross-volume fallback and collision handling, the restore action, sidecars, empty folders, results summary, retry.
*Accept:* trashed files are restorable from the Recycle Bin; quarantined files arrive intact with their folder structure mirrored, survive a cross-volume move with size verification, and restore to their exact original paths; the quarantine folder never appears in a scan even when nested inside the library root; a move batch reports moved bytes rather than reclaimed space; a locked file fails cleanly and keeps its mark; `fs.unlink` is reachable only via the setting or the prompt, verified by reading the call sites; same-basename sidecars follow their track, album art stays while siblings remain and leaves with the last one; quitting with marks pending and relaunching surfaces the resume screen with the right count.

### M7 — Settings and stats
Settings screen per §8 with persistence, disposal-mode explanation, stats screen per §6.8.
*Accept:* every setting persists across restart and takes effect without one; stats reconcile with a manual count over the fixture.

### M8 — Themes, polish, and package
Both themes per §9.1 with the token system, card design per §9.2, motion tuning per §9.3, empty and error states, keyboard shortcut help, `electron-builder` NSIS installer, `electron-updater` against GitHub Releases, signing if a certificate is available.
*Accept:* every screen is checked in both themes with no hardcoded colors and no AA failures; switching themes mid-session is instant with no flash, and a dark-theme launch shows no white blink; swipe motion holds 60 fps and all three input methods produce identical exits; installs and runs on a clean Windows machine; a full triage session on a real library completes without a crash or lost decision; a published test release is detected and installed by an older build.

### Testing notes
Generate a synthetic library fixture (a few hundred small files with varied tags, some untagged, one corrupt, one `.wma`, one 90-minute file, a large FLAC with a SEEKTABLE and one with it stripped, an `.m4a` with a trailing `moov` atom, sidecars, album folders with and without `cover.jpg`, byte-identical duplicates, staggered creation dates) and use it for M2–M7. Disposal tests must run against the fixture, never a real library.

Also generate a 200,000-entry synthetic index (paths only, no real files) and assert against it that: a swipe write completes in under 50 ms, `session:start` returns in under 500 ms, and the renderer's memory does not grow with library size.

Every budget in §3.7 is a test, not a guideline. Measure them in CI against the fixture with `performance.now()` and fail the build on regression.

---

## 11. Notes for distribution

**Code signing.** Unsigned installers trigger a SmartScreen warning on download, which can be lived with for a small release. If you'd rather avoid it, Azure Artifact Signing (formerly Trusted Signing) is around $10/month and integrates with `electron-builder`; eligibility is currently limited by region, so confirm before committing. EV certificates no longer bypass SmartScreen and are not worth the premium for this purpose.

**Auto-update.** `electron-updater` pointed at GitHub Releases needs no server. Publish the NSIS installer plus `latest.yml` to each release. Check on launch, download in the background, install on quit, and never interrupt an active session with an update prompt.

---

## 12. Open questions

1. **Fingerprint cost on first scan of a huge library.** 200k files means 200k extra 64KB reads. On an SSD that's a minute or two; on a spinning disk or a NAS it could be much worse. Worth a "quick scan" mode that defers fingerprinting until a file first reaches the queue?
2. **Sidecar `.m3u` playlists** referencing a deleted track are left pointing at nothing. Ignore, or offer a cleanup pass?
3. **Stats retention** if `decisions.json` is ever lost or reset — rebuild what's rebuildable from the index, or start the counters from zero?
