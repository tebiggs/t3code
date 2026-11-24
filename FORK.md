# Fork notes

This is a fork of T3 Code. `main` is upstream's newest nightly plus the
features listed below.

- **Releases.** `.github/workflows/fork-release.yml` builds the Windows x64
  desktop app, the Linux x64 and arm64 servers and the Android APK. The daily
  sync starts it on `main` once a day, when `main` has a commit no build has
  run on yet. To release sooner, run it on `main` from the Actions tab or with
  `gh workflow run fork-release.yml --ref main`.
  When typecheck and the tests covering the fork's changes pass, it publishes
  everything as a prerelease here.
  The fork's apps update from these releases. Pull requests get only the
  typecheck, those tests and the JS bundle, to keep the fork's Actions usage
  down: GitHub pauses Actions on forks that use too much. A run on any other
  branch builds everything without publishing, for example to try an APK.
- **Upstream sync.** A T3 scheduled task follows `.github/fork/daily-sync.md`
  once a day:
  - It merges upstream's newest nightly tag into `main`.
  - It opens a `sync-conflict/*` PR when the merge conflicts, and merges it
    once nothing blocks it.
  - It starts the day's release build.
  - It opens a `dedup/*` PR when upstream ships something that replaces a
    fork feature. Those wait for review.
- **Merge sync-conflict PRs with a merge commit, never squash.** Squashing
  drops upstream's history, and every later sync would then conflict.

## Fork features

Give each feature one line: its PR, what it does, and its main paths. The daily
sync compares upstream changes against this list. Add the line in the PR that
adds the feature, and remove it in the PR that drops the feature.

- #2 Servers and clients update from this fork's releases instead of
  upstream's: `packages/shared/src/cliRelease.ts`,
  `apps/server/src/cloud/npmRelease.ts`.
- #14 Background work an agent waits on keeps its thread working until the result reaches the
  agent; settling cannot detach that work, wake dispatches retry, and work lost with a provider
  session or Claude process is reported. After a provider crash or a Claude process exit,
  upstream's provider-exit continuation (pingdotgg/t3code#40170, pingdotgg/t3code#30214) wakes the
  agent instead: `ClaudeAdapterV2.ts`
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
  server with its own T3 Connect sign-in. View only or Full control sets what the
  server's T3 Connect credentials grant, and changing it signs out other clients.
  Off and signing out end the tunnel and other clients' sessions, Ongoing activity
  skips the phone's server, and the Android bridge asks on the phone for each Ask
  each time command: `apps/server/src/cloud/CloudLink.ts` (`setSharingMode`),
  `apps/server/src/auth/EnvironmentAuth.ts` (`revokeOtherAccess`),
  `packages/contracts/src/auth.ts` (`AuthViewOnlyClientScopes`),
  `apps/mobile/src/features/phone/phone-sharing.ts`,
  `apps/mobile/src/features/phone/phone-sharing-controller.ts`,
  `apps/mobile/src/features/phone/phone-sharing-commands.ts`,
  `apps/mobile/src/features/phone/PhoneSharingSection.tsx`,
  `apps/mobile/src/features/agent-awareness/liveActivityPreferences.ts`,
  `apps/mobile/modules/t3-device-runtime/android/src/main/java/expo/modules/t3deviceruntime/AccessApproval.kt`.
- #21 Open in VS Code and other SSH editor links use the host the client reached directly when
  sshd is listening, instead of the server's first advertised host: `apps/web/src/remoteOpen.ts`,
  `apps/server/src/environment/RemoteOpenTargets.ts` (`sshd`).
- #32 The Android APK is the fork's own app: an ember icon and splash screen, plus the package name, app name, release
  keystore and Firebase config from repository variables and secrets when they are set:
  `apps/mobile/app.config.ts` (`T3CODE_ANDROID_PACKAGE`), `.github/workflows/fork-release.yml`.
- #45 A server started with an FCM service account key is the push host: it sends the
  fork's Android app its notifications and ongoing activity card, for itself and for environments
  linked to it, with upstream's relay payloads; the app registers there and shows its status in
  Settings → Notifications: `apps/server/src/fork/push/`,
  `apps/server/src/relay/AgentAwarenessRelay.ts` (`ForkPushTarget`),
  `packages/contracts/src/forkPush.ts`, `apps/mobile/src/features/fork-push/`,
  `apps/mobile/src/features/agent-awareness/androidNotifications.ts`
  (`forkOwnsAndroidAgentNotifications`), `apps/server/vite.config.ts` (`resolve.modules`),
  `docs/user/push-host.md`.
