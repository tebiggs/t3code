import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  ASLEEP_AFTER_FAILING_MS,
  INITIAL_POWER_RUNTIME,
  lastOutputLine,
  MAX_INPUT_WRITES,
  needsInput,
  normalizeMacAddress,
  POWER_MAC_ENV_KEY,
  powerStatus,
  reducePower,
  resolvePowerCommand,
  shellInputFor,
  SLEEP_CONFIRM_TIMEOUT_MS,
  sleepTarget,
  WAKE_TIMEOUT_MS,
  wakeTarget,
  type PowerEvent,
  type PowerRuntime,
} from "./environment-power";

const failed = { phase: "reconnecting", error: "Connection timed out" } as const;
const connected = { phase: "connected", error: null } as const;
const ASLEEP: PowerRuntime = { ...INITIAL_POWER_RUNTIME, mode: "asleep", asleepSince: 20_000 };

function run(state: PowerRuntime, events: ReadonlyArray<PowerEvent>) {
  const effects: Array<string | null> = [];
  for (const event of events) {
    const next = reducePower(state, event);
    state = next.state;
    effects.push(next.effect);
  }
  return { state, effects };
}

describe("reducePower", () => {
  it("treats an awake machine as asleep only after failures persist", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "connection", connection: { phase: "connecting", error: null }, now: 1 },
      { type: "connection", connection: failed, now: 5 },
      { type: "tick", now: 5 + ASLEEP_AFTER_FAILING_MS - 1 },
      { type: "tick", now: 5 + ASLEEP_AFTER_FAILING_MS },
    ]);
    expect(effects).toEqual([null, null, null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: 5 + ASLEEP_AFTER_FAILING_MS });
  });

  it("keeps retrying through a short outage such as a dropped socket on resume", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "connection", connection: failed, now: 5 },
      { type: "connection", connection: connected, now: 8 },
      { type: "tick", now: 5 + ASLEEP_AFTER_FAILING_MS },
    ]);
    expect(effects).toEqual([null, null, null]);
    expect(state).toEqual(INITIAL_POWER_RUNTIME);
  });

  it("doesn't count failures while the phone itself is offline", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "connection", connection: failed, now: 5 },
      { type: "connection", connection: { phase: "offline", error: null }, now: 6 },
      { type: "tick", now: 5 + ASLEEP_AFTER_FAILING_MS },
    ]);
    expect(effects).toEqual([null, null, null]);
    expect(state.mode).toBe("auto");
  });

  it("confirms an asleep machine with one failed check and keeps the original asleep time", () => {
    const { state, effects } = run(ASLEEP, [
      { type: "check" },
      { type: "connection", connection: failed, now: 90_000 },
    ]);
    expect(effects).toEqual(["resume", "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: ASLEEP.asleepSince });
  });

  it("pauses again when something else restarts the loop of an asleep machine", () => {
    const { state, effects } = run(ASLEEP, [
      { type: "connection", connection: { phase: "connecting", error: null }, now: 40_000 },
      { type: "connection", connection: failed, now: 45_000 },
    ]);
    expect(effects).toEqual([null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: ASLEEP.asleepSince });
  });

  it("becomes awake when a check reaches the machine", () => {
    const { state } = run(ASLEEP, [
      { type: "check" },
      { type: "connection", connection: connected, now: 50_000 },
    ]);
    expect(state).toEqual(INITIAL_POWER_RUNTIME);
  });

  it("keeps retrying through failures while waking, then settles once connected", () => {
    const { state, effects } = run(ASLEEP, [
      { type: "wake-started" },
      { type: "wake-sent", now: 100 },
      { type: "connection", connection: failed, now: 101 },
      { type: "tick", now: 110 },
      { type: "connection", connection: connected, now: 115 },
    ]);
    expect(effects).toEqual([null, "resume", null, null, null]);
    expect(state).toEqual(INITIAL_POWER_RUNTIME);
  });

  it("gives up on a wake that never connects", () => {
    const { state, effects } = run(ASLEEP, [
      { type: "wake-started" },
      { type: "wake-sent", now: 100 },
      { type: "tick", now: 100 + WAKE_TIMEOUT_MS },
    ]);
    expect(effects.at(-1)).toBe("pause");
    expect(state.mode).toBe("asleep");
    expect(state.error).not.toBeNull();
  });

  it("reports a wake command that failed and stays asleep", () => {
    const { state, effects } = run(ASLEEP, [
      { type: "wake-started" },
      { type: "wake-failed", error: "pc-power: command not found", now: 7 },
    ]);
    expect(effects.at(-1)).toBe("pause");
    expect(state).toMatchObject({ mode: "asleep", error: "pc-power: command not found" });
  });

  it("marks a sent sleep asleep only once the connection fails", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "connection", connection: connected, now: 1 },
      { type: "sleep-started" },
      { type: "sleep-sent", now: 3 },
      { type: "connection", connection: connected, now: 4 },
      { type: "tick", now: 8 },
      { type: "connection", connection: failed, now: 12 },
    ]);
    expect(effects).toEqual([null, null, null, null, null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: 12, error: null });
  });

  it("reports a sent sleep that didn't take and keeps reconnecting", () => {
    const sent = run(INITIAL_POWER_RUNTIME, [
      { type: "sleep-started" },
      { type: "sleep-sent", now: 3 },
      { type: "tick", now: 3 + SLEEP_CONFIRM_TIMEOUT_MS - 1 },
    ]);
    expect(sent.state.mode).toBe("sleeping");
    const { state, effects } = run(sent.state, [
      { type: "tick", now: 3 + SLEEP_CONFIRM_TIMEOUT_MS },
    ]);
    expect(effects).toEqual([null]);
    expect(state).toMatchObject({
      mode: "auto",
      asleepSince: null,
      error: "It didn't go to sleep.",
    });
    expect(powerStatus(state, connected)).toBe("awake");
  });

  it("marks a sent sleep asleep when a live probe goes unanswered", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "sleep-started" },
      { type: "probe-failed", now: 2 },
      { type: "sleep-sent", now: 3 },
      { type: "probe-failed", now: 8 },
    ]);
    expect(effects).toEqual([null, null, null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: 8 });
  });

  it("counts a connection lost while the sleep command finished", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "sleep-started" },
      { type: "connection", connection: failed, now: 2 },
      { type: "sleep-sent", now: 3 },
    ]);
    expect(effects).toEqual([null, null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: 3 });
  });

  it("rechecks instead of sleeping when a stale awake machine doesn't answer", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "connection", connection: connected, now: 1 },
      { type: "sleep-started" },
      { type: "sleep-unreachable" },
      { type: "connection", connection: { phase: "connecting", error: null }, now: 4 },
      { type: "connection", connection: failed, now: 9 },
      { type: "tick", now: 9 + ASLEEP_AFTER_FAILING_MS },
    ]);
    expect(effects).toEqual([null, null, "recheck", null, null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", error: null });
  });

  it("keeps the grace period after a missed probe whose recheck succeeds", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "sleep-started" },
      { type: "sleep-unreachable" },
      { type: "connection", connection: failed, now: 30 },
    ]);
    expect(effects).toEqual([null, "recheck", null]);
    expect(state).toMatchObject({ mode: "auto", asleepSince: null, failingSince: 30 });
  });

  it("undoes a pause that landed after a late connected update", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "sleep-started" },
      { type: "sleep-sent", now: 3 },
      { type: "probe-failed", now: 4 },
      { type: "connection", connection: connected, now: 5 },
      { type: "connection", connection: { phase: "available", error: null }, now: 6 },
    ]);
    expect(effects).toEqual([null, null, "pause", null, "resume"]);
    expect(state.mode).toBe("auto");
  });

  it("stays awake with an error when the sleep command fails", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "sleep-started" },
      { type: "sleep-failed", error: "exit 1" },
    ]);
    expect(effects).toEqual([null, null]);
    expect(state).toMatchObject({ mode: "auto", error: "exit 1" });
  });
});

describe("powerStatus", () => {
  it("prefers an in-flight action over the connection phase", () => {
    expect(powerStatus({ ...INITIAL_POWER_RUNTIME, mode: "waking" }, connected)).toBe("waking");
    expect(powerStatus({ ...INITIAL_POWER_RUNTIME, mode: "sleeping" }, connected)).toBe("sleeping");
  });

  it("separates asleep, checking, and phone-offline", () => {
    const asleep = { ...INITIAL_POWER_RUNTIME, mode: "asleep", asleepSince: 1 } as const;
    expect(powerStatus(asleep, { phase: "available", error: null })).toBe("asleep");
    expect(powerStatus(INITIAL_POWER_RUNTIME, { phase: "connecting", error: null })).toBe(
      "checking",
    );
    expect(powerStatus(INITIAL_POWER_RUNTIME, { phase: "offline", error: null })).toBe("offline");
    expect(powerStatus(INITIAL_POWER_RUNTIME, connected)).toBe("awake");
  });

  it("keeps showing asleep while a periodic check is in flight", () => {
    const checking = { ...ASLEEP, mode: "auto" } as const;
    expect(powerStatus(checking, { phase: "connecting", error: null })).toBe("asleep");
    expect(powerStatus(checking, connected)).toBe("awake");
  });
});

describe("lastOutputLine", () => {
  it("returns the last printed line without colors or the echoed command", () => {
    const output =
      'exec sh -c "$T3_POWER_COMMAND"\r\n\u001b[31merror:\u001b[0m lease held by codex-rng-1\r\n\r\n';
    expect(lastOutputLine(output)).toBe("error: lease held by codex-rng-1");
  });

  it("returns null when nothing was printed", () => {
    expect(lastOutputLine('exec sh -c "$T3_POWER_COMMAND"\r\n')).toBeNull();
  });
});

describe("normalizeMacAddress", () => {
  it("accepts common separators and casing", () => {
    expect(normalizeMacAddress("1A-2B-3C-4D-5E-6F")).toBe("1a:2b:3c:4d:5e:6f");
    expect(normalizeMacAddress(" 1a2b.3c4d.5e6f ")).toBe("1a:2b:3c:4d:5e:6f");
  });

  it("rejects anything that isn't 12 hex digits", () => {
    expect(normalizeMacAddress("1a:2b:3c:4d:5e")).toBeNull();
    expect(normalizeMacAddress("1a:2b:3c:4d:5e:6g")).toBeNull();
  });
});

describe("resolvePowerCommand", () => {
  it("passes the MAC without separators and picks the sender for the relay's OS", () => {
    const posix = resolvePowerCommand({ kind: "wake", macAddress: "1a:2b:3c:4d:5e:6f" }, "linux");
    const windows = resolvePowerCommand(
      { kind: "wake", macAddress: "1a:2b:3c:4d:5e:6f" },
      "windows",
    );
    expect(posix?.env).toEqual({ [POWER_MAC_ENV_KEY]: "1a2b3c4d5e6f" });
    expect(posix?.command).toContain("python3");
    expect(windows?.command).toContain("UdpClient");
  });

  it("runs the built-in sleep in the foreground and has none for an unknown OS", () => {
    expect(resolvePowerCommand({ kind: "sleep" }, "unknown")).toBeNull();
    expect(resolvePowerCommand({ kind: "sleep" }, "linux")?.command).toBe("systemctl suspend");
    expect(resolvePowerCommand({ kind: "sleep" }, "windows")?.command).not.toContain(
      "Start-Process",
    );
  });

  it("runs custom commands as given", () => {
    expect(resolvePowerCommand({ kind: "custom", command: "pc-power wake" }, "linux")).toEqual({
      command: "pc-power wake",
      env: {},
    });
  });
});

describe("needsInput", () => {
  const running = { status: "running", history: "" } as const;
  const echoed = { status: "running", history: 'exec sh -c "$T3_POWER_COMMAND"\r\n' } as const;

  it("writes to a new shell and again after a reattach that never saw the input", () => {
    expect(needsInput(running, 0)).toBe(true);
    expect(needsInput(running, 1)).toBe(true);
    expect(needsInput(running, MAX_INPUT_WRITES)).toBe(false);
  });

  it("leaves a shell alone once it echoed the input or exited", () => {
    expect(needsInput(echoed, 1)).toBe(false);
    expect(needsInput({ status: "exited", history: "" }, 1)).toBe(false);
  });
});

describe("shellInputFor", () => {
  it("uses PowerShell on Windows and a POSIX shell elsewhere", () => {
    expect(shellInputFor("windows")).toContain("$env:T3_POWER_COMMAND");
    expect(shellInputFor("darwin")).toBe('exec sh -c "$T3_POWER_COMMAND"\r');
  });
});

describe("power targets", () => {
  const desktop = EnvironmentId.make("desktop");
  const relay = EnvironmentId.make("relay");
  const builtIn = {
    relayEnvironmentId: relay,
    macAddress: "1A2B3C4D5E6F",
    wakeCommand: "",
    sleepCommand: "",
  };

  it("wakes through the relay and sleeps on the machine itself by default", () => {
    expect(wakeTarget(builtIn)).toEqual({
      environmentId: relay,
      command: { kind: "wake", macAddress: "1a:2b:3c:4d:5e:6f" },
    });
    expect(sleepTarget(desktop, builtIn)).toEqual({
      environmentId: desktop,
      command: { kind: "sleep" },
    });
  });

  it("runs custom commands on the relay", () => {
    const custom = {
      ...builtIn,
      wakeCommand: "pc-power wake",
      sleepCommand: "pc-power sleep --force",
    };
    expect(wakeTarget(custom)).toEqual({
      environmentId: relay,
      command: { kind: "custom", command: "pc-power wake" },
    });
    expect(sleepTarget(desktop, custom)).toEqual({
      environmentId: relay,
      command: { kind: "custom", command: "pc-power sleep --force" },
    });
  });

  it("never falls back to the built-in sleep without settings", () => {
    expect(sleepTarget(desktop, undefined)).toHaveProperty("error");
  });

  it("explains what's missing before a built-in wake can run", () => {
    expect(wakeTarget({ ...builtIn, macAddress: "" })).toHaveProperty("error");
    expect(wakeTarget({ ...builtIn, relayEnvironmentId: null })).toHaveProperty("error");
  });
});
