import type { EnvironmentShellSummary } from "@t3tools/client-runtime/state/shell";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { projectWorkspaceEnvironment, projectWorkspaceState } from "./workspaceModel";
import type { EnvironmentPresentation } from "./environments";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function environment(
  phase: EnvironmentPresentation["connection"]["phase"],
): EnvironmentPresentation {
  const connectionId = `bearer:${ENVIRONMENT_ID}`;
  return {
    environmentId: ENVIRONMENT_ID,
    label: "Julius's MacBook Pro",
    displayUrl: "https://environment.example.test",
    relayManaged: false,
    entry: {
      target: new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Julius's MacBook Pro",
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "Julius's MacBook Pro",
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        }),
      ),
      enabled: true,
    },
    connection: {
      phase,
      error: phase === "error" ? "Connection failed." : null,
      traceId: phase === "error" ? "trace-1" : null,
    },
    serverConfig: null,
  };
}

const EMPTY_SHELL_SUMMARY: EnvironmentShellSummary = {
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
};

const CACHED_SHELL_SUMMARY: EnvironmentShellSummary = {
  ...EMPTY_SHELL_SUMMARY,
  hasSnapshot: true,
  hasSynchronizingShell: true,
  hasCachedShell: true,
};

describe("mobile workspace projection", () => {
  it("reports offline before stale connected presentations", () => {
    const environments = [projectWorkspaceEnvironment(ENVIRONMENT_ID, environment("connected"))];
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "offline",
      environments,
      shellSummary: EMPTY_SHELL_SUMMARY,
      hasSyncingConnectedEnvironment: false,
    });

    expect(state.connectionState).toBe("offline");
    expect(state.networkStatus).toBe("offline");
    expect(state.hasReadyEnvironment).toBe(false);
  });

  it("keeps retained snapshots visible while reconnecting without claiming readiness", () => {
    const environments = [projectWorkspaceEnvironment(ENVIRONMENT_ID, environment("reconnecting"))];
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments,
      shellSummary: CACHED_SHELL_SUMMARY,
      hasSyncingConnectedEnvironment: false,
    });

    expect(state.hasLoadedShellSnapshot).toBe(true);
    expect(state.hasPendingShellSnapshot).toBe(true);
    expect(state.hasSyncingConnectedEnvironment).toBe(false);
    expect(state.hasReadyEnvironment).toBe(false);
    expect(state.connectionState).toBe("reconnecting");
  });

  it("leaves a sleeping power-managed machine out of the reconnecting status until it connects", () => {
    const desktopId = EnvironmentId.make("environment-2");
    const quietEnvironmentIds = new Set([desktopId]);
    const project = (desktopPhase: EnvironmentPresentation["connection"]["phase"]) =>
      projectWorkspaceState({
        isReady: true,
        networkStatus: "online",
        environments: [projectWorkspaceEnvironment(desktopId, environment(desktopPhase))],
        quietEnvironmentIds,
        shellSummary: EMPTY_SHELL_SUMMARY,
      });

    const asleep = project("reconnecting");
    expect(asleep.hasConnectingEnvironment).toBe(false);
    expect(asleep.connectionState).toBe("available");

    const awake = project("connected");
    expect(awake.hasReadyEnvironment).toBe(true);
    expect(awake.connectionState).toBe("connected");
  });
});
