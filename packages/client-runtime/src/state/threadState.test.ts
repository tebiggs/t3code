import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { threadHasCaughtUpTo, threadOldestLoadedAt } from "./threadState.ts";

const WINDOW = {
  hasMoreHistory: true,
  oldestLoadedAt: "2026-09-06T11:00:00.000Z",
} as const;

describe("threadHasCaughtUpTo", () => {
  it("prefers the commit sequence over searching paged-out history", () => {
    expect(
      threadHasCaughtUpTo({ messageId: "m1", sequence: 40 }, { sequence: 45, messages: [] }),
    ).toBe(true);
    expect(
      threadHasCaughtUpTo(
        { messageId: "m1", sequence: 50 },
        { sequence: 45, messages: [{ id: "m1" }] },
      ),
    ).toBe(true);
  });

  it("does not let the window bound override an unreached sequence", () => {
    expect(
      threadHasCaughtUpTo(
        { messageId: "m1", sequence: 50, createdAt: "2026-09-06T10:00:00.000Z" },
        { sequence: 45, messages: [], ...WINDOW },
      ),
    ).toBe(false);
  });

  it("treats a sequenceless write older than the loaded window as caught up", () => {
    expect(
      threadHasCaughtUpTo(
        { messageId: "m1", createdAt: "2026-09-06T10:00:00.000Z" },
        { sequence: 45, messages: [], ...WINDOW },
      ),
    ).toBe(true);
    expect(
      threadHasCaughtUpTo(
        { messageId: "m1", createdAt: "2026-09-06T12:00:00.000Z" },
        { sequence: 45, messages: [], ...WINDOW },
      ),
    ).toBe(false);
    expect(
      threadHasCaughtUpTo(
        { messageId: "m1", createdAt: "2026-09-06T10:00:00.000Z" },
        {
          sequence: 45,
          messages: [],
          hasMoreHistory: false,
          oldestLoadedAt: WINDOW.oldestLoadedAt,
        },
      ),
    ).toBe(false);
  });
});

describe("threadOldestLoadedAt", () => {
  const row = (startedAt: string | null, updatedAt: string): OrchestrationV2ProjectedTurnItem => {
    const id = "item-0" as never;
    return {
      position: 0,
      visibility: "local",
      sourceThreadId: v2ThreadId,
      sourceItemId: id,
      item: {
        id,
        type: "command_execution",
        threadId: v2ThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Command",
        input: "cmd",
        output: "out",
        exitCode: 0,
        startedAt: startedAt === null ? null : DateTime.makeUnsafe(startedAt),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(updatedAt),
      },
    };
  };

  it("returns the first item's start, falling back to its update time", () => {
    expect(threadOldestLoadedAt([])).toBeNull();
    expect(
      threadOldestLoadedAt([
        row("2026-09-06T11:00:00.000Z", "2026-09-06T11:05:00.000Z"),
        row("2026-09-06T12:00:00.000Z", "2026-09-06T12:00:00.000Z"),
      ]),
    ).toBe("2026-09-06T11:00:00.000Z");
    expect(threadOldestLoadedAt([row(null, "2026-09-06T11:05:00.000Z")])).toBe(
      "2026-09-06T11:05:00.000Z",
    );
  });
});
