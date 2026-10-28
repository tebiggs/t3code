# Fork notes

This is a fork of T3 Code. `main` is upstream's newest nightly plus the
features listed below.

- **Releases.** Every push to `main` builds the Windows x64 desktop app, the
  Linux x64 and arm64 servers and the Android APK. The build runs in
  `.github/workflows/fork-release.yml`, which can also be run by hand on
  `main` from the Actions tab or with `gh workflow run fork-release.yml`.
  When typecheck and the tests covering the fork's changes pass, it publishes
  everything as a prerelease here.
  The fork's apps update from these releases. Pull requests get the same
  checks and builds but publish nothing.
- **Upstream sync.** A T3 scheduled task follows `.github/fork/daily-sync.md`
  once a day:
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

- #2 Servers and clients update from this fork's releases instead of
  upstream's: `packages/shared/src/cliRelease.ts`,
  `apps/web/src/state/npmRelease.ts`.
- Background shells and Monitors keep a Claude thread working until their results reach the
  agent, unless it marks them as left running with `t3_background_wait` (`waiting: false`);
  automatic settlement cannot detach that work, wake dispatches retry, and work lost with a
  provider session is reported: `ClaudeAdapterV2.ts` (`unawaitedBackgroundTasksByNativeThread`,
  `deliveringBackgroundTasksByNativeThread`), `mcp/toolkits/orchestrator/tools.ts`,
  `Orchestrator.ts` (`automaticSettlementBlocker`), `ProviderSessionManager.ts`,
  `ProviderContinuationService.ts`.
- #4 The Android app's Home shows whether a desktop is awake and can put it to
  sleep or wake it, sending Wake-on-LAN through another connected environment
  on the same LAN: `apps/mobile/src/features/power/`,
  `apps/mobile/src/persistence/mobile-preferences.ts` (`environmentPower`),
  `apps/mobile/src/state/workspaceModel.ts`.
- #9 The Android app can set the phone up as its own environment: Claude Code
  and a T3 Code server run in Ubuntu inside Termux, driven through Termux's
  RUN_COMMAND intent: `apps/mobile/modules/t3-termux/`,
  `apps/mobile/src/features/phone/`,
  `apps/mobile/src/persistence/mobile-preferences.ts` (`phoneServer`). The
  phone warns when it runs upstream's server, telling builds apart by #2's
  release repo inside the binary.
