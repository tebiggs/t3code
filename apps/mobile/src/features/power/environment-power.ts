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
/** Matches the supervisor's quick probe when the app returns to the foreground. */
export const LIVE_PROBE_TIMEOUT_MS = 3_000;
/**
 * An awake machine counts as asleep only after failing to connect for this long, so a dropped
 * socket on app resume or a server restart doesn't pause it.
 */
export const ASLEEP_AFTER_FAILING_MS = 20_000;
/** While the app is open, how often a machine believed asleep gets one connection attempt. */
export const ASLEEP_RECHECK_INTERVAL_MS = 60_000;

/**
 * The command travels in an environment variable so it needs no quoting, and `exec` makes the
 * shell's exit status the command's. Works in bash, zsh, and fish.
 */
export const RELAY_COMMAND_ENV_KEY = "T3_POWER_COMMAND";
export const RELAY_SHELL_INPUT = `exec sh -c "$${RELAY_COMMAND_ENV_KEY}"\r`;

export type PowerMode = "auto" | "asleep" | "waking" | "sleeping";

export interface PowerRuntime {
  readonly mode: PowerMode;
  /** Set while the machine is believed asleep, including while a check is in flight. */
  readonly asleepSince: number | null;
  /** When a machine believed awake started failing to connect. */
  readonly failingSince: number | null;
  readonly wakeDeadline: number | null;
  readonly error: string | null;
}

export const INITIAL_POWER_RUNTIME: PowerRuntime = {
  mode: "auto",
  asleepSince: null,
  failingSince: null,
  wakeDeadline: null,
  error: null,
};

export interface PowerConnection {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
}

export type PowerEvent =
  | { readonly type: "connection"; readonly connection: PowerConnection; readonly now: number }
  /** The app came to the foreground, or a periodic check of an asleep machine is due. */
  | { readonly type: "check" }
  | { readonly type: "wake-started" }
  | { readonly type: "wake-sent"; readonly now: number }
  | { readonly type: "wake-failed"; readonly error: string; readonly now: number }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "sleep-started" }
  /** The machine didn't answer before a sleep, so the "awake" it showed was stale. */
  | { readonly type: "sleep-unreachable"; readonly now: number }
  | { readonly type: "sleep-succeeded"; readonly now: number }
  | { readonly type: "sleep-failed"; readonly error: string };

/**
 * `pause` stops the environment's reconnect loop, `resume` restarts it, and `recheck` asks the
 * supervisor to probe the live session now.
 */
export type PowerEffect = "pause" | "resume" | "recheck" | null;

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
      failingSince: null,
      wakeDeadline: null,
      error,
    },
    effect: "pause",
  } as const;
}

function failingTooLong(state: PowerRuntime, now: number): boolean {
  return state.failingSince !== null && now - state.failingSince >= ASLEEP_AFTER_FAILING_MS;
}

/**
 * Asleep is inferred from reachability. A power-managed environment that keeps failing to
 * connect is treated as asleep and stops retrying, apart from one attempt when the app returns
 * to the foreground and once a minute while it stays open, until the user wakes it.
 */
export function reducePower(
  state: PowerRuntime,
  event: PowerEvent,
): { readonly state: PowerRuntime; readonly effect: PowerEffect } {
  const unchanged = { state, effect: null } as const;
  switch (event.type) {
    case "connection": {
      const { phase } = event.connection;
      if (phase === "connected") {
        if (state.mode === "sleeping") return unchanged;
        if (state.mode === "auto" && state.asleepSince === null && state.failingSince === null) {
          return unchanged;
        }
        return {
          state: { ...INITIAL_POWER_RUNTIME, error: state.mode === "waking" ? null : state.error },
          effect: null,
        };
      }
      if (state.mode === "auto" && connectionFailed(event.connection)) {
        // Checking a machine already believed asleep takes one failure; an awake one needs a run.
        if (state.asleepSince !== null || failingTooLong(state, event.now)) {
          return fellAsleep(state, event.now, state.error);
        }
        return state.failingSince === null
          ? { state: { ...state, failingSince: event.now }, effect: null }
          : unchanged;
      }
      // The phone losing its network says nothing about the machine.
      if (state.mode === "auto" && phase === "offline" && state.failingSince !== null) {
        return { state: { ...state, failingSince: null }, effect: null };
      }
      // Something else restarted the paused loop, such as switching the environment back on.
      // Treat it as a check so a failure pauses it again.
      if (state.mode === "asleep" && (phase === "connecting" || phase === "reconnecting")) {
        return { state: { ...state, mode: "auto" }, effect: null };
      }
      return unchanged;
    }
    case "check":
      return state.mode === "asleep"
        ? { state: { ...state, mode: "auto", error: null }, effect: "resume" }
        : unchanged;
    case "wake-started":
      return {
        state: { ...state, mode: "waking", failingSince: null, wakeDeadline: null, error: null },
        effect: null,
      };
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
      if (
        state.mode === "waking" &&
        state.wakeDeadline !== null &&
        event.now >= state.wakeDeadline
      ) {
        return fellAsleep(state, event.now, "It didn't come back online. Try waking it again.");
      }
      // Retries can keep reporting the same failure, so no new connection event arrives.
      return state.mode === "auto" && failingTooLong(state, event.now)
        ? fellAsleep(state, event.now, state.error)
        : unchanged;
    case "sleep-started":
      return { state: { ...state, mode: "sleeping", error: null }, effect: null };
    case "sleep-unreachable":
      // Nothing was sent. The supervisor's own check ends the dead session, and the failed
      // reconnect then pauses it through the connection branch above.
      return {
        state: {
          ...state,
          mode: "auto",
          asleepSince: state.asleepSince ?? event.now,
          failingSince: null,
          error: null,
        },
        effect: "recheck",
      };
    case "sleep-succeeded":
      return {
        state: { ...INITIAL_POWER_RUNTIME, mode: "asleep", asleepSince: event.now },
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
  // Includes a check in flight, so the periodic check doesn't flicker the chip.
  if (state.asleepSince !== null) return "asleep";
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
