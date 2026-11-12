import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

import * as Upstream from "./FcmDeliveries.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import {
  androidAlertForAggregate,
  androidAlertForState,
} from "../../../../apps/server/src/fork/push/androidAlerts.ts";

const base: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Fix notifications",
  phase: "running",
  headline: "Working",
  modelTitle: "Claude",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const other: RelayAgentActivityState = {
  ...base,
  threadId: ThreadId.make("other"),
  threadTitle: "Other",
  deepLink: "/threads/env/other",
};
const nowMs = Date.parse("2026-01-01T00:00:30.000Z");
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const aggregate = (states: ReadonlyArray<RelayAgentActivityState>) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs })!;

// The copies in androidAlerts.ts must match upstream's relay, which the phone's native code follows.
describe("androidAlerts", () => {
  it.each([
    ["waiting_for_approval"],
    ["waiting_for_input"],
    ["completed"],
    ["failed"],
    ["running"],
  ] as const)("matches upstream for a %s state", (phase) => {
    const state = { ...base, phase };
    expect(androidAlertForState(state, preferences, nowMs)).toEqual(
      Upstream.androidAlertForState(state, preferences, nowMs),
    );
  });

  it.each([
    [
      "one thread starts waiting",
      [base, other],
      [{ ...base, phase: "waiting_for_input" as const }, other],
    ],
    [
      "two threads finish",
      [base, other],
      [
        { ...base, phase: "completed" as const },
        { ...other, phase: "failed" as const },
      ],
    ],
    ["nothing changes", [base], [base]],
  ])("matches upstream when %s", (_name, previous, next) => {
    const input = {
      previousAggregate: aggregate(previous),
      nextAggregate: aggregate(next),
      preferences,
      nowMs,
    };
    expect(androidAlertForAggregate(input)).toEqual(Upstream.androidAlertForAggregate(input));
  });
});
