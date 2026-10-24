import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import type { EnvironmentPowerSettings } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPowerSettingsAtom } from "../../state/environment-power-settings";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  probeEnvironment,
  runRelayCommand,
  setEnvironmentConnectionDesired,
} from "./environment-power-commands";
import {
  ASLEEP_RECHECK_INTERVAL_MS,
  DEFAULT_SLEEP_COMMAND,
  DEFAULT_WAKE_COMMAND,
  INITIAL_POWER_RUNTIME,
  reducePower,
  WAKE_RETRY_INTERVAL_MS,
  type PowerEvent,
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
  return {
    relayEnvironmentId,
    wakeCommand: DEFAULT_WAKE_COMMAND,
    sleepCommand: DEFAULT_SLEEP_COMMAND,
  };
}

function setRuntime(environmentId: EnvironmentId, next: PowerRuntime | null) {
  const current = appAtomRegistry.get(environmentPowerRuntimeAtom);
  const updated = new Map(current);
  if (next === null) updated.delete(environmentId);
  else updated.set(environmentId, next);
  appAtomRegistry.set(environmentPowerRuntimeAtom, updated);
}

function setConnectionDesired(environmentId: EnvironmentId, desired: boolean) {
  void runAtomCommand(appAtomRegistry, setEnvironmentConnectionDesired, { environmentId, desired });
}

function retryConnection(environmentId: EnvironmentId) {
  void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId, {
    reportFailure: false,
  });
}

function dispatch(environmentId: EnvironmentId, event: PowerEvent) {
  const previous =
    appAtomRegistry.get(environmentPowerRuntimeAtom).get(environmentId) ?? INITIAL_POWER_RUNTIME;
  const { state, effect } = reducePower(previous, event);
  if (state !== previous) setRuntime(environmentId, state);
  if (effect === "recheck") retryConnection(environmentId);
  else if (effect !== null) setConnectionDesired(environmentId, effect === "resume");
}

async function runPowerCommand(
  environmentId: EnvironmentId,
  pick: (settings: EnvironmentPowerSettings) => string,
): Promise<string | null> {
  const settings = appAtomRegistry.get(environmentPowerSettingsAtom)[environmentId];
  if (!settings?.relayEnvironmentId) return "Choose a machine to send the command through.";
  const result = await runAtomCommand(
    appAtomRegistry,
    runRelayCommand,
    { relayEnvironmentId: settings.relayEnvironmentId, command: pick(settings) },
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The command could not be run.";
}

export async function wakeEnvironment(environmentId: EnvironmentId) {
  dispatch(environmentId, { type: "wake-started" });
  const error = await runPowerCommand(environmentId, (settings) => settings.wakeCommand);
  dispatch(
    environmentId,
    error === null
      ? { type: "wake-sent", now: Date.now() }
      : { type: "wake-failed", error, now: Date.now() },
  );
}

export async function sleepEnvironment(environmentId: EnvironmentId) {
  dispatch(environmentId, { type: "sleep-started" });
  const probe = await runAtomCommand(appAtomRegistry, probeEnvironment, environmentId, {
    reportFailure: false,
  });
  if (!AsyncResult.isSuccess(probe) || !probe.value) {
    dispatch(environmentId, { type: "sleep-unreachable", now: Date.now() });
    return;
  }
  const error = await runPowerCommand(environmentId, (settings) => settings.sleepCommand);
  dispatch(
    environmentId,
    error === null ? { type: "sleep-succeeded", now: Date.now() } : { type: "sleep-failed", error },
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
      if (!environment.isEnabled || settings[environment.environmentId] === undefined) continue;
      dispatch(environment.environmentId, {
        type: "connection",
        connection: { phase: environment.connectionState, error: environment.connectionError },
        now,
      });
    }
    // Power control was turned off: hand the environment back to the normal reconnect loop.
    for (const [environmentId, state] of appAtomRegistry.get(environmentPowerRuntimeAtom)) {
      if (settings[environmentId] !== undefined) continue;
      if (state.mode === "asleep") setConnectionDesired(environmentId, true);
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

  const ticking = states.some(
    (state) =>
      (state.mode === "waking" && state.wakeDeadline !== null) ||
      (state.mode === "auto" && state.failingSince !== null),
  );
  useEffect(() => {
    if (!ticking) return;
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [environmentId, state] of appAtomRegistry.get(environmentPowerRuntimeAtom)) {
        const waking = state.mode === "waking" && state.wakeDeadline !== null;
        if (!waking && !(state.mode === "auto" && state.failingSince !== null)) continue;
        dispatch(environmentId, { type: "tick", now });
        if (
          waking &&
          appAtomRegistry.get(environmentPowerRuntimeAtom).get(environmentId)?.mode === "waking"
        ) {
          retryConnection(environmentId);
        }
      }
    }, WAKE_RETRY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [ticking]);
}

function checkAsleepEnvironments() {
  for (const environmentId of appAtomRegistry.get(environmentPowerRuntimeAtom).keys()) {
    dispatch(environmentId, { type: "check" });
  }
}
