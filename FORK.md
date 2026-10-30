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
- #14 Background work an agent waits on keeps its thread working until the result reaches the
  agent; settling cannot detach that work, wake dispatches retry, and work lost with a provider
  session or Claude process is reported: `ClaudeAdapterV2.ts`
  (`deliveringBackgroundTasksByNativeThread`, `finalizeActiveTurnAfterQueryExit`),
  `Orchestrator.ts` (`automaticSettlementBlocker`), `ThreadManagementService.ts`
  (`settleAfterRun`), `ProviderSessionManager.ts`, `ProviderContinuationService.ts`,
  `evals/mcp-tool-use/cases/background-work.ndjson`.
- #4 The Android app's Home shows whether a desktop is awake and can put it to
  sleep or wake it, sending Wake-on-LAN through another connected environment
  on the same LAN: `apps/mobile/src/features/power/`,
  `apps/mobile/src/persistence/mobile-preferences.ts` (`environmentPower`),
  `apps/mobile/src/state/workspaceModel.ts`.
- #11 The Android app can set the phone up as its own environment: it downloads
  Ubuntu into its own storage and runs it through proot from the APK's native
  libraries, with the T3 server and Claude Code (from Anthropic's apt
  repository) under a foreground service. It replaced #9's Termux setup:
  `apps/mobile/modules/t3-device-runtime/`,
  `apps/mobile/src/features/device-runtime/`,
  `apps/mobile/src/features/phone/`,
  `apps/mobile/src/persistence/mobile-preferences.ts` (`phoneServer`).
- #19 The phone's server can be shared with the user's other devices through
  T3 Connect: the app installs cloudflared in the phone's Ubuntu and links the
  server with its own T3 Connect sign-in. Off and signing out end the tunnel and
  other clients' sessions, Ongoing activity skips the phone's server, and the
  Android bridge asks on the phone for each Ask each time command:
  `apps/mobile/src/features/phone/phone-sharing.ts`,
  `apps/mobile/src/features/phone/phone-sharing-controller.ts`,
  `apps/mobile/src/features/phone/phone-sharing-commands.ts`,
  `apps/mobile/src/features/phone/PhoneSharingSection.tsx`,
  `apps/mobile/src/features/agent-awareness/liveActivityPreferences.ts`,
  `apps/mobile/modules/t3-device-runtime/android/src/main/java/expo/modules/t3deviceruntime/AccessApproval.kt`.
