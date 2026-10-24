import { describe, expect, it } from "vite-plus/test";

import {
  ASLEEP_AFTER_FAILING_MS,
  INITIAL_POWER_RUNTIME,
  lastOutputLine,
  powerStatus,
  reducePower,
  WAKE_TIMEOUT_MS,
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

  it("pauses after a successful sleep and ignores the dropped connection", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "sleep-started" },
      { type: "connection", connection: failed, now: 2 },
      { type: "sleep-succeeded", now: 3 },
    ]);
    expect(effects).toEqual([null, null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: 3 });
  });

  it("rechecks instead of sleeping when a stale awake machine doesn't answer", () => {
    const { state, effects } = run(INITIAL_POWER_RUNTIME, [
      { type: "connection", connection: connected, now: 1 },
      { type: "sleep-started" },
      { type: "sleep-unreachable", now: 3 },
      { type: "connection", connection: { phase: "connecting", error: null }, now: 4 },
      { type: "connection", connection: failed, now: 9 },
    ]);
    expect(effects).toEqual([null, null, "recheck", null, "pause"]);
    expect(state).toMatchObject({ mode: "asleep", asleepSince: 3, error: null });
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
