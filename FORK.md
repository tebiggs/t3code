# Fork notes

This is Tim Biggs's fork of T3 Code. `main` is upstream's newest nightly plus
the features listed below.

- **Releases.** Every push to `main` builds the Windows x64 desktop app, the
  Linux x64 server and the Android APK. The build runs in
  `.github/workflows/fork-release.yml`. When typecheck and the tests for
  fork-changed packages pass, it publishes everything as a prerelease here.
  The fork's apps update from these releases. Pull requests get the same
  checks and builds but publish nothing.
- **Upstream sync.** A T3 scheduled task on pylon2 follows
  `.github/fork/daily-sync.md` once a day:
  - It merges upstream's newest nightly tag into `main`.
  - It opens a `sync-conflict/*` PR when the merge conflicts.
  - It opens a `dedup/*` PR when upstream ships something that replaces a
    fork feature.
- **Merge sync-conflict PRs with a merge commit, never squash.** Squashing
  drops upstream's history, and every later sync would then conflict.

## Fork features

Give each feature one line: its PR, what it does, and its main paths. The daily
sync compares upstream changes against this list. Add the line in the PR that
adds the feature, and remove it in the PR that drops the feature.
