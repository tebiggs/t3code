import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import type { EnvironmentPowerSettings } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPowerSettingsAtom } from "../../state/environment-power-settings";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useWorkspaceEnvironments, workspaceConnections } from "../../state/workspace";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import {
  checkThroughRelay,
  probeEnvironment,
  retryEnvironmentIfWaiting,
  runPowerCommand,
  setEnvironmentConnectionDesired,
} from "./environment-power-commands";
import {
  ACTION_CHECK_INTERVAL_MS,
  ASLEEP_RECHECK_INTERVAL_MS,
  INITIAL_POWER_RUNTIME,
  reducePower,
  relayCheckTarget,
  sleepTarget,
  wakeTarget,
  type PowerEvent,
  type PowerTarget,
  type PowerRuntime,
} from "./environment-power";

export const environmentPowerRuntimeAtom = Atom.make<ReadonlyMap<EnvironmentId, PowerRuntime>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("mobile:environment-power:runtime"));

export function useEnvironmentPowerSettings() {
  return useAtomValue(environmentPowerSettingsAtom);
}

export function useEnvironmentPowerRuntime(environmentId: EnvironmentId): PowerRuntime {
  return useAtomValue(environmentPowerRuntimeAtom).get(environmentId) ?? INITIAL_POWER_RUNTIME;
}

export function setEnvironmentPowerSettings(
  environmentId: EnvironmentId,
  settings: EnvironmentPowerSettings | null,
) {
  appAtomRegistry.set(updateMobilePreferencesAtom, {
    transform: (current) => {
      const { [environmentId]: _previous, ...rest } = current.environmentPower ?? {};
      return {
        environmentPower: settings === null ? rest : { ...rest, [environmentId]: settings },
      };
    },
  });
}

export function defaultEnvironmentPowerSettings(
  relayEnvironmentId: EnvironmentId | null,
): EnvironmentPowerSettings {
  return { relayEnvironmentId, macAddress: "", wakeCommand: "", sleepCommand: "" };
}

/** Switched-off and removed environments are left alone, so nothing here reconnects them. */
function isEnabledEnvironment(environmentId: EnvironmentId): boolean {
  return appAtomRegistry
    .get(workspaceConnections.environmentsAtom)
    .some((environment) => environment.environmentId === environmentId && environment.isEnabled);
}

function setRuntime(environmentId: EnvironmentId, next: PowerRuntime | null) {
  const current = appAtomRegistry.get(environmentPowerRuntimeAtom);
  const updated = new Map(current);
  if (next === null) updated.delete(environmentId);
  else updated.set(environmentId, next);
  appAtomRegistry.set(environmentPowerRuntimeAtom, updated);
}

function setConnectionDesired(environmentId: EnvironmentId, desired: boolean) {
  if (desired && !isEnabledEnvironment(environmentId)) return;
  void runAtomCommand(appAtomRegistry, setEnvironmentConnectionDesired, { environmentId, desired });
}

function retryConnection(environmentId: EnvironmentId) {
  void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId, {
    reportFailure: false,
  });
}

function dispatch(environmentId: EnvironmentId, event: PowerEvent) {
  // A result that lands after power control was turned off belongs to the normal loop now.
  if (settingsFor(environmentId) === undefined) return;
  const previous =
    appAtomRegistry.get(environmentPowerRuntimeAtom).get(environmentId) ?? INITIAL_POWER_RUNTIME;
  const { state, effect } = reducePower(previous, event);
  if (state !== previous) setRuntime(environmentId, state);
  if (effect === "recheck") retryConnection(environmentId);
  else if (effect !== null) setConnectionDesired(environmentId, effect === "resume");
}

async function runOn(target: PowerTarget): Promise<string | null> {
  if ("error" in target) return target.error;
  const result = await runAtomCommand(appAtomRegistry, runPowerCommand, target, {
    reportFailure: false,
  });
  if (AsyncResult.isSuccess(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The command could not be run.";
}

function settingsFor(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentPowerSettingsAtom)[environmentId];
}

export async function wakeEnvironment(environmentId: EnvironmentId) {
  dispatch(environmentId, { type: "wake-started" });
  const error = await runOn(wakeTarget(settingsFor(environmentId)));
  dispatch(
    environmentId,
    error === null
      ? { type: "wake-sent", now: Date.now() }
      : { type: "wake-failed", error, now: Date.now() },
  );
}

async function isAnswering(environmentId: EnvironmentId): Promise<boolean> {
  const probe = await runAtomCommand(appAtomRegistry, probeEnvironment, environmentId, {
    reportFailure: false,
  });
  return AsyncResult.isSuccess(probe) && probe.value;
}

export async function sleepEnvironment(environmentId: EnvironmentId) {
  // Resolved before the probe, so what runs is what the user saw when they asked.
  const settings = settingsFor(environmentId);
  const target = sleepTarget(environmentId, settings);
  dispatch(environmentId, { type: "sleep-started" });
  if (!(await isAnswering(environmentId))) {
    dispatch(environmentId, { type: "sleep-unreachable" });
    return;
  }
  if (!isEnabledEnvironment(environmentId) || !Equal.equals(settingsFor(environmentId), settings)) {
    dispatch(environmentId, {
      type: "sleep-failed",
      error: "Power settings changed while checking the machine, so nothing was sent.",
    });
    return;
  }
  const error = await runOn(target);
  dispatch(
    environmentId,
    error === null ? { type: "sleep-sent", now: Date.now() } : { type: "sleep-failed", error },
  );
}

/** Drives asleep detection, foreground checks, and wake retries. Mount once. */
export function useEnvironmentPowerWorker() {
  const settings = useEnvironmentPowerSettings();
  const environments = useWorkspaceEnvironments();
  const runtime = useAtomValue(environmentPowerRuntimeAtom);

  useEffect(() => {
    const now = Date.now();
    for (const environment of environments) {
      const powerSettings = settings[environment.environmentId];
      if (!environment.isEnabled || powerSettings === undefined) continue;
      dispatch(environment.environmentId, {
        type: "connection",
        connection: { phase: environment.connectionState, error: environment.connectionError },
        now,
      });
      startLaunchCheck(environment, powerSettings, environments);
    }
    for (const environmentId of appAtomRegistry.get(environmentPowerRuntimeAtom).keys()) {
      // Switched off or removed: the catalog owns it now, so drop it without reconnecting.
      if (!isEnabledEnvironment(environmentId)) {
        setRuntime(environmentId, null);
        continue;
      }
      // Power control was turned off: hand the environment back to the normal reconnect loop,
      // which an asleep machine or a wake in flight may have left paused.
      if (settings[environmentId] !== undefined) continue;
      setConnectionDesired(environmentId, true);
      setRuntime(environmentId, null);
    }
  }, [environments, settings]);

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (previous !== "active" && next === "active") checkAsleepEnvironments();
      previous = next;
    });
    return () => subscription.remove();
  }, []);

  const states = [...runtime.values()];
  const anyAsleep = states.some((state) => state.mode === "asleep");
  useEffect(() => {
    if (!anyAsleep) return;
    const interval = setInterval(() => {
      if (AppState.currentState === "active") checkAsleepEnvironments();
    }, ASLEEP_RECHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [anyAsleep]);

  const ticking = states.some(needsTicks);
  useEffect(() => {
    if (!ticking) return;
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [environmentId, state] of appAtomRegistry.get(environmentPowerRuntimeAtom)) {
        if (!needsTicks(state)) continue;
        dispatch(environmentId, { type: "tick", now });
        const next = appAtomRegistry.get(environmentPowerRuntimeAtom).get(environmentId);
        if (next?.mode === "waking") {
          void runAtomCommand(appAtomRegistry, retryEnvironmentIfWaiting, environmentId, {
            reportFailure: false,
          });
        } else if (next?.mode === "sleeping" && next.deadline !== null) {
          // A machine that just fell asleep keeps reading as connected until its socket times out.
          void confirmAsleep(environmentId);
        }
      }
    }, ACTION_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [ticking]);
}

function needsTicks(state: PowerRuntime): boolean {
  return (
    ((state.mode === "waking" || state.mode === "sleeping") && state.deadline !== null) ||
    (state.mode === "auto" && state.failingSince !== null)
  );
}

async function confirmAsleep(environmentId: EnvironmentId) {
  if (!(await isAnswering(environmentId))) {
    dispatch(environmentId, { type: "probe-failed", now: Date.now() });
  }
}

// At most one check per app launch and settings, and none once the machine has connected. Later
// outages keep the grace period instead, because the relay can't tell a sleeping machine from one
// whose server is restarting.
const launchChecks = new Map<EnvironmentId, EnvironmentPowerSettings | "connected">();

function startLaunchCheck(
  environment: WorkspaceEnvironment,
  settings: EnvironmentPowerSettings,
  environments: ReadonlyArray<WorkspaceEnvironment>,
) {
  const { environmentId } = environment;
  if (environment.connectionState === "connected") {
    launchChecks.set(environmentId, "connected");
    return;
  }
  const previous = launchChecks.get(environmentId);
  if (previous === "connected" || Equal.equals(previous, settings)) return;
  const target = relayCheckTarget(environmentId, settings);
  if (target === null) return;
  const relay = environments.find((entry) => entry.environmentId === target.environmentId);
  if (relay?.isEnabled !== true || relay.connectionState !== "connected") return;
  launchChecks.set(environmentId, settings);
  void runAtomCommand(appAtomRegistry, checkThroughRelay, target, { reportFailure: false }).then(
    (result) => {
      if (!AsyncResult.isSuccess(result) || result.value !== "silent") return;
      // Dropped if the machine connected meanwhile, or the user changed the address or relay.
      if (launchChecks.get(environmentId) !== settings) return;
      if (!Equal.equals(settingsFor(environmentId), settings)) return;
      // Only while its own connection is still trying: a blocked one already answered.
      const current = appAtomRegistry
        .get(workspaceConnections.environmentsAtom)
        .find((entry) => entry.environmentId === environmentId);
      if (
        current?.isEnabled !== true ||
        (current.connectionState !== "connecting" && current.connectionState !== "reconnecting")
      ) {
        return;
      }
      dispatch(environmentId, { type: "relay-silent", now: Date.now() });
    },
  );
}

function checkAsleepEnvironments() {
  for (const environmentId of appAtomRegistry.get(environmentPowerRuntimeAtom).keys()) {
    if (isEnabledEnvironment(environmentId)) dispatch(environmentId, { type: "check" });
  }
}
