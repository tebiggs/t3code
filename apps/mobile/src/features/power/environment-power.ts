import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  threadRuntimeIsActive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";

export const DEFAULT_WAKE_COMMAND = "pc-power wake";
export const DEFAULT_SLEEP_COMMAND = "pc-power sleep --force";

/** How long a woken machine has to reconnect before it counts as asleep again. */
export const WAKE_TIMEOUT_MS = 150_000;
/** The supervisor's backoff doubles from 1 s, which is too slow for a machine that answers in ~10 s. */
export const WAKE_RETRY_INTERVAL_MS = 5_000;
/** Upper bound for one relay command, including shell startup. */
export const RELAY_COMMAND_TIMEOUT_MS = 60_000;

/**
 * The command travels in an environment variable so it needs no quoting, and `exec` makes the
 * shell's exit status the command's. Works in bash, zsh, and fish.
 */
export const RELAY_COMMAND_ENV_KEY = "T3_POWER_COMMAND";
export const RELAY_SHELL_INPUT = `exec sh -c "$${RELAY_COMMAND_ENV_KEY}"\r`;

export type PowerMode = "auto" | "asleep" | "waking" | "sleeping";

export interface PowerRuntime {
  readonly mode: PowerMode;
  readonly asleepSince: number | null;
  readonly wakeDeadline: number | null;
  readonly error: string | null;
}

export const INITIAL_POWER_RUNTIME: PowerRuntime = {
  mode: "auto",
  asleepSince: null,
  wakeDeadline: null,
  error: null,
};

export interface PowerConnection {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
}

export type PowerEvent =
  | { readonly type: "connection"; readonly connection: PowerConnection; readonly now: number }
  | { readonly type: "foreground" }
  | { readonly type: "wake-started" }
  | { readonly type: "wake-sent"; readonly now: number }
  | { readonly type: "wake-failed"; readonly error: string; readonly now: number }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "sleep-started" }
  | { readonly type: "sleep-succeeded"; readonly now: number }
  | { readonly type: "sleep-failed"; readonly error: string };

/** `pause` stops the environment's reconnect loop; `resume` restarts it. */
export type PowerEffect = "pause" | "resume" | null;

function connectionFailed(connection: PowerConnection): boolean {
  return (
    connection.phase === "error" ||
    (connection.phase === "reconnecting" && connection.error !== null)
  );
}

function fellAsleep(state: PowerRuntime, now: number, error: string | null = null) {
  return {
    state: {
      mode: "asleep",
      asleepSince: state.asleepSince ?? now,
      wakeDeadline: null,
      error,
    },
    effect: "pause",
  } as const;
}

/**
 * Asleep is inferred from reachability: a power-managed environment that fails to connect is
 * treated as asleep and stops retrying until the app returns to the foreground or the user
 * wakes it.
 */
export function reducePower(
  state: PowerRuntime,
  event: PowerEvent,
): { readonly state: PowerRuntime; readonly effect: PowerEffect } {
  const unchanged = { state, effect: null } as const;
  switch (event.type) {
    case "connection":
      if (event.connection.phase === "connected") {
        if (state.mode === "sleeping" || (state.mode === "auto" && state.asleepSince === null)) {
          return unchanged;
        }
        return {
          state: {
            mode: "auto",
            asleepSince: null,
            wakeDeadline: null,
            error: state.mode === "waking" ? null : state.error,
          },
          effect: null,
        };
      }
      if (state.mode === "auto" && connectionFailed(event.connection)) {
        return fellAsleep(state, event.now, state.error);
      }
      // Something else restarted the paused loop, such as switching the environment back on.
      // Treat it as a check so a failure pauses it again.
      if (
        state.mode === "asleep" &&
        (event.connection.phase === "connecting" || event.connection.phase === "reconnecting")
      ) {
        return { state: { ...state, mode: "auto" }, effect: null };
      }
      return unchanged;
    case "foreground":
      return state.mode === "asleep"
        ? { state: { ...state, mode: "auto", error: null }, effect: "resume" }
        : unchanged;
    case "wake-started":
      return { state: { ...state, mode: "waking", wakeDeadline: null, error: null }, effect: null };
    case "wake-sent":
      return state.mode === "waking"
        ? {
            state: { ...state, wakeDeadline: event.now + WAKE_TIMEOUT_MS },
            effect: "resume",
          }
        : unchanged;
    case "wake-failed":
      return fellAsleep(state, event.now, event.error);
    case "tick":
      return state.mode === "waking" &&
        state.wakeDeadline !== null &&
        event.now >= state.wakeDeadline
        ? fellAsleep(state, event.now, "It didn't come back online. Try waking it again.")
        : unchanged;
    case "sleep-started":
      return { state: { ...state, mode: "sleeping", error: null }, effect: null };
    case "sleep-succeeded":
      return {
        state: { mode: "asleep", asleepSince: event.now, wakeDeadline: null, error: null },
        effect: "pause",
      };
    case "sleep-failed":
      return { state: { ...state, mode: "auto", error: event.error }, effect: null };
  }
}

export type PowerStatus = "awake" | "asleep" | "waking" | "sleeping" | "checking" | "offline";

export function powerStatus(state: PowerRuntime, connection: PowerConnection): PowerStatus {
  if (state.mode === "sleeping") return "sleeping";
  if (state.mode === "waking") return "waking";
  if (connection.phase === "connected") return "awake";
  if (state.mode === "asleep") return "asleep";
  return connection.phase === "offline" ? "offline" : "checking";
}

export const POWER_STATUS_LABELS: Record<PowerStatus, string> = {
  awake: "Awake",
  asleep: "Asleep",
  waking: "Waking…",
  sleeping: "Going to sleep…",
  checking: "Checking…",
  offline: "Offline",
};

/** Threads whose agent is running on the environment, which sleeping would interrupt. */
export function countActiveThreads(
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly runtime?: ThreadRuntimeSummary | null;
  }>,
  environmentId: EnvironmentId,
): number {
  return threads.filter(
    (thread) => thread.environmentId === environmentId && threadRuntimeIsActive(thread.runtime),
  ).length;
}

// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/** The last line the command printed, for showing why it failed. */
export function lastOutputLine(output: string): string | null {
  const lines = output
    .replace(ANSI_PATTERN, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes(RELAY_COMMAND_ENV_KEY));
  return lines.at(-1) ?? null;
}
