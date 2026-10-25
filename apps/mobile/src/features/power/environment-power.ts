import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  threadRuntimeIsActive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  TerminalSessionSnapshot,
} from "@t3tools/contracts";

import type { EnvironmentPowerSettings } from "../../persistence/mobile-preferences";

/** How long a woken machine has to reconnect before it counts as asleep again. */
export const WAKE_TIMEOUT_MS = 150_000;
/**
 * How often a wake or sleep in flight is checked. The supervisor's backoff doubles from 1 s,
 * which is too slow for a machine that answers in ~10 s.
 */
export const ACTION_CHECK_INTERVAL_MS = 5_000;
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

/** Upper bound for writing to or closing the throwaway terminal, so a lost reply can't hold the action open. */
export const TERMINAL_REQUEST_TIMEOUT_MS = 5_000;
/**
 * A built-in sleep that hasn't exited this long after its input reached the shell counts as
 * sent. Some OS sleep calls only return after the machine wakes up again.
 */
export const SLEEP_SETTLE_MS = 5_000;
/** How long a sent sleep has to make the machine stop answering before it counts as refused. */
export const SLEEP_CONFIRM_TIMEOUT_MS = 45_000;
/** The first write plus retries after a reattach shows the input never arrived. */
export const MAX_INPUT_WRITES = 3;

/** Upper bound for the launch check, including shell startup. After it, the normal connection decides. */
export const RELAY_CHECK_TIMEOUT_MS = 10_000;
/** The port `t3` and the desktop app listen on unless it was taken. */
export const DEFAULT_SERVER_PORT = 3773;

export const RELAY_COMMAND_ENV_KEY = "T3_POWER_COMMAND";
export const POWER_MAC_ENV_KEY = "T3_POWER_MAC";
export const CHECK_HOST_ENV_KEY = "T3_POWER_CHECK_HOST";
export const CHECK_PORT_ENV_KEY = "T3_POWER_CHECK_PORT";
export const CHECK_ENVIRONMENT_ENV_KEY = "T3_POWER_CHECK_ENVIRONMENT";
/** Exit status of the built-in check when nothing answered. Any failure of the shell itself exits 1. */
export const CHECK_SILENT_EXIT_CODE = 3;

/**
 * The command travels in an environment variable so it needs no quoting, and the shell ends with
 * the command's exit status. POSIX input works in bash, zsh and fish; Windows terminals open
 * PowerShell.
 */
export function shellInputFor(os: ExecutionEnvironmentPlatformOs): string {
  return os === "windows"
    ? `$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; try { & ([scriptblock]::Create($env:${RELAY_COMMAND_ENV_KEY})) } catch { Write-Output $_; exit 1 }; exit [int]$LASTEXITCODE\r`
    : `exec sh -c "$${RELAY_COMMAND_ENV_KEY}"\r`;
}

/**
 * What to run: a user-supplied command, or the built-in wake (a Wake-on-LAN broadcast sent from a
 * relay on the same network) or sleep (run on the machine itself).
 */
export type PowerCommand =
  | { readonly kind: "custom"; readonly command: string }
  | { readonly kind: "wake"; readonly macAddress: string }
  | { readonly kind: "sleep" }
  | {
      readonly kind: "check";
      readonly address: LocalAddress;
      readonly environmentId: EnvironmentId;
    };

// python3 ships with most Linux distributions and macOS developer tools; no extra package needed.
const POSIX_WAKE = `python3 -c 'import os,socket;m=bytes.fromhex(os.environ["${POWER_MAC_ENV_KEY}"]);s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);s.sendto(b"\\xff"*6+m*16,("255.255.255.255",9))'`;
const WINDOWS_WAKE = `$m=[byte[]]($env:${POWER_MAC_ENV_KEY} -split '(..)' -ne '' | ForEach-Object { [Convert]::ToByte($_,16) }); $p=[byte[]](@(0xFF)*6 + $m*16); $u=New-Object Net.Sockets.UdpClient; $u.EnableBroadcast=$true; [void]$u.Send($p,$p.Length,'255.255.255.255',9); $u.Close()`;

// Each sleep runs in the foreground so a refusal reaches the phone as a failed exit. A call that
// hasn't returned by SLEEP_SETTLE_MS counts as sent.
const SLEEP_BY_OS: Partial<Record<ExecutionEnvironmentPlatformOs, string>> = {
  linux: "systemctl suspend",
  darwin: "pmset sleepnow",
  windows: `Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)) { throw 'Windows refused to sleep.' }`,
};

// Run on the relay, so the machine is on the same network and a second of silence means it's down.
// A refused connection or an answer from another server isn't silence, and "no route to host" is
// what the network stack reports when the machine doesn't answer address lookups.
const POSIX_CHECK = `python3 -c '
import errno,json,os,socket,sys,urllib.request
h=os.environ["${CHECK_HOST_ENV_KEY}"]
p=int(os.environ["${CHECK_PORT_ENV_KEY}"])
try:
  socket.create_connection((h,p),1).close()
except socket.timeout:
  sys.exit(${CHECK_SILENT_EXIT_CODE})
except OSError as e:
  sys.exit(${CHECK_SILENT_EXIT_CODE} if e.errno in (errno.EHOSTUNREACH,errno.EHOSTDOWN) else 2)
try:
  d=json.load(urllib.request.urlopen("http://%s:%d/.well-known/t3/environment"%(h,p),timeout=2))
except Exception:
  sys.exit(2)
sys.exit(0 if d.get("environmentId")==os.environ["${CHECK_ENVIRONMENT_ENV_KEY}"] else 2)
'`;

export function resolvePowerCommand(
  command: PowerCommand,
  os: ExecutionEnvironmentPlatformOs,
): { readonly command: string; readonly env: Readonly<Record<string, string>> } | null {
  switch (command.kind) {
    case "custom":
      return { command: command.command, env: {} };
    case "wake":
      return {
        command: os === "windows" ? WINDOWS_WAKE : POSIX_WAKE,
        env: { [POWER_MAC_ENV_KEY]: command.macAddress.replaceAll(":", "") },
      };
    case "sleep": {
      const sleep = SLEEP_BY_OS[os];
      return sleep === undefined ? null : { command: sleep, env: {} };
    }
    case "check":
      return os === "linux" || os === "darwin"
        ? {
            command: POSIX_CHECK,
            env: {
              [CHECK_HOST_ENV_KEY]: command.address.host,
              [CHECK_PORT_ENV_KEY]: String(command.address.port),
              [CHECK_ENVIRONMENT_ENV_KEY]: command.environmentId,
            },
          }
        : null;
  }
}

export type RelayCheck = "answered" | "silent" | "unknown";

export function relayCheckResult(exitCode: number | null): RelayCheck {
  if (exitCode === 0) return "answered";
  return exitCode === CHECK_SILENT_EXIT_CODE ? "silent" : "unknown";
}

export type PowerTarget =
  | { readonly environmentId: EnvironmentId; readonly command: PowerCommand }
  | { readonly error: string };

/** Custom commands run on the relay. The built-in wake does too; the built-in sleep runs on the machine itself. */
export function wakeTarget(settings: EnvironmentPowerSettings | undefined): PowerTarget {
  if (!settings?.relayEnvironmentId) {
    return { error: "Choose a machine on the same network to send the wake through." };
  }
  const custom = settings.wakeCommand.trim();
  if (custom.length > 0) {
    return {
      environmentId: settings.relayEnvironmentId,
      command: { kind: "custom", command: custom },
    };
  }
  const macAddress = normalizeMacAddress(settings.macAddress ?? "");
  return macAddress === null
    ? { error: "Add this machine's MAC address in Power settings to wake it." }
    : { environmentId: settings.relayEnvironmentId, command: { kind: "wake", macAddress } };
}

export function sleepTarget(
  environmentId: EnvironmentId,
  settings: EnvironmentPowerSettings | undefined,
): PowerTarget {
  if (settings === undefined) return { error: "Sleep and wake is turned off for this machine." };
  const custom = settings.sleepCommand.trim();
  if (custom.length === 0) return { environmentId, command: { kind: "sleep" } };
  return settings.relayEnvironmentId
    ? { environmentId: settings.relayEnvironmentId, command: { kind: "custom", command: custom } }
    : { error: "Choose a machine to send the custom sleep command through." };
}

/**
 * The launch check: the relay looks for this machine's T3 server at its local address, which
 * answers within seconds whether it's asleep. Null when there's nothing to check with.
 */
export function relayCheckTarget(
  environmentId: EnvironmentId,
  settings: EnvironmentPowerSettings,
): { readonly environmentId: EnvironmentId; readonly command: PowerCommand } | null {
  const address = parseLocalAddress(settings.localAddress ?? "");
  return settings.relayEnvironmentId && address
    ? {
        environmentId: settings.relayEnvironmentId,
        command: { kind: "check", address, environmentId },
      }
    : null;
}

export interface LocalAddress {
  readonly host: string;
  readonly port: number;
}

/** A host name or IPv4 address with an optional port, or null when the input isn't one. */
export function parseLocalAddress(input: string): LocalAddress | null {
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(input.trim());
  if (!match) return null;
  const port = match[2] === undefined ? DEFAULT_SERVER_PORT : Number(match[2]);
  return port >= 1 && port <= 65_535 ? { host: match[1]!, port } : null;
}

/** Canonical `aa:bb:cc:dd:ee:ff`, or null when the input isn't a MAC address. */
export function normalizeMacAddress(input: string): string | null {
  const hex = input.replace(/[\s:.-]/g, "").toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) ? (hex.match(/../g)?.join(":") ?? null) : null;
}

export type PowerMode = "auto" | "asleep" | "waking" | "sleeping";

export interface PowerRuntime {
  readonly mode: PowerMode;
  /** Set while the machine is believed asleep, including while a check is in flight. */
  readonly asleepSince: number | null;
  /** When a machine believed awake, or being put to sleep, started failing to connect. */
  readonly failingSince: number | null;
  /** When a sent wake or sleep gives up. Null while its command is still running. */
  readonly deadline: number | null;
  readonly error: string | null;
}

export const INITIAL_POWER_RUNTIME: PowerRuntime = {
  mode: "auto",
  asleepSince: null,
  failingSince: null,
  deadline: null,
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
  /** The machine didn't answer before a sleep, so the "awake" it showed may be stale. */
  | { readonly type: "sleep-unreachable" }
  /** The sleep was handed over; the machine still has to stop answering. */
  | { readonly type: "sleep-sent"; readonly now: number }
  | { readonly type: "sleep-failed"; readonly error: string }
  /** A live-session probe after a sent sleep got no answer. */
  | { readonly type: "probe-failed"; readonly now: number }
  /** The launch check found nothing answering at the machine's local address. */
  | { readonly type: "relay-silent"; readonly now: number };

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
      deadline: null,
      error,
    },
    effect: "pause",
  } as const;
}

function failingTooLong(state: PowerRuntime, now: number): boolean {
  return state.failingSince !== null && now - state.failingSince >= ASLEEP_AFTER_FAILING_MS;
}

function confirmingSleep(state: PowerRuntime): boolean {
  return state.mode === "sleeping" && state.deadline !== null;
}

/**
 * Asleep is inferred from reachability. A power-managed environment that keeps failing to
 * connect is treated as asleep and stops retrying, apart from one attempt when the app returns
 * to the foreground and once a minute while it stays open, until the user wakes it. A sent sleep
 * only counts once the machine stops answering.
 */
export function reducePower(
  state: PowerRuntime,
  event: PowerEvent,
): { readonly state: PowerRuntime; readonly effect: PowerEffect } {
  const unchanged = { state, effect: null } as const;
  switch (event.type) {
    case "connection": {
      const { phase } = event.connection;
      if (state.mode === "sleeping") {
        if (connectionFailed(event.connection)) {
          if (confirmingSleep(state)) return fellAsleep(state, event.now);
          // The command may still report back, so only remember the failure for now.
          return state.failingSince === null
            ? { state: { ...state, failingSince: event.now }, effect: null }
            : unchanged;
        }
        return phase === "connected" && state.failingSince !== null
          ? { state: { ...state, failingSince: null }, effect: null }
          : unchanged;
      }
      if (phase === "connected") {
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
      // "available" means the loop is paused. Outside asleep or an action in flight that is a
      // leftover pause, for example one that landed after a late connected update, so undo it.
      if (state.mode === "auto" && phase === "available") {
        return { state, effect: "resume" };
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
        state: { ...state, mode: "waking", failingSince: null, deadline: null, error: null },
        effect: null,
      };
    case "wake-sent":
      return state.mode === "waking"
        ? {
            state: { ...state, deadline: event.now + WAKE_TIMEOUT_MS },
            effect: "resume",
          }
        : unchanged;
    case "wake-failed":
      return fellAsleep(state, event.now, event.error);
    case "tick": {
      const expired = state.deadline !== null && event.now >= state.deadline;
      if (expired && state.mode === "waking") {
        return fellAsleep(state, event.now, "It didn't come back online. Try waking it again.");
      }
      // Still answering, so the reconnect loop keeps running and the machine shows as awake.
      if (expired && state.mode === "sleeping") {
        return {
          state: { ...INITIAL_POWER_RUNTIME, error: "It didn't go to sleep." },
          effect: null,
        };
      }
      // Retries can keep reporting the same failure, so no new connection event arrives.
      return state.mode === "auto" && failingTooLong(state, event.now)
        ? fellAsleep(state, event.now, state.error)
        : unchanged;
    }
    case "sleep-started":
      return {
        state: { ...state, mode: "sleeping", failingSince: null, deadline: null, error: null },
        effect: null,
      };
    case "sleep-unreachable":
      // Nothing was sent. The supervisor's own check ends a dead session, and the failed
      // reconnects then pause it through the connection branch above. One missed probe isn't
      // proof of sleep, so a session that answers the recheck stays plainly awake.
      return { state: { ...state, mode: "auto", error: null }, effect: "recheck" };
    case "sleep-sent":
      if (state.mode !== "sleeping") return unchanged;
      // The connection already dropped while the command was finishing.
      if (state.failingSince !== null) return fellAsleep(state, event.now);
      return {
        state: { ...state, deadline: event.now + SLEEP_CONFIRM_TIMEOUT_MS },
        effect: null,
      };
    case "sleep-failed":
      return {
        state: { ...state, mode: "auto", deadline: null, error: event.error },
        effect: null,
      };
    case "probe-failed":
      return confirmingSleep(state) ? fellAsleep(state, event.now) : unchanged;
    case "relay-silent":
      // Shown as asleep straight away, but the loop keeps running: one more failure pauses it
      // through the connection branch, and connecting makes it awake.
      return state.mode === "auto" && state.asleepSince === null
        ? { state: { ...state, asleepSince: event.now, failingSince: null }, effect: null }
        : unchanged;
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

/**
 * Whether a terminal (re)attach snapshot needs the command input written. A reattach after a
 * dropped connection can't tell whether the last write landed, but the shell echoes the input
 * line, which names the variable.
 */
export function needsInput(
  snapshot: Pick<TerminalSessionSnapshot, "status" | "history">,
  writes: number,
): boolean {
  return (
    writes < MAX_INPUT_WRITES &&
    (snapshot.status === "starting" || snapshot.status === "running") &&
    !snapshot.history.includes(RELAY_COMMAND_ENV_KEY)
  );
}

/** The last line the command printed, for showing why it failed. */
export function lastOutputLine(output: string): string | null {
  const lines = output
    .replace(ANSI_PATTERN, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    // The terminal echoes the input line, which names the variable.
    .filter((line) => line.length > 0 && !line.includes(RELAY_COMMAND_ENV_KEY));
  return lines.at(-1) ?? null;
}
