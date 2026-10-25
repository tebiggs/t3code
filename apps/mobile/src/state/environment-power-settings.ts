import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentPowerSettings } from "../persistence/mobile-preferences";
import { mobilePreferencesAtom } from "./preferences";

const EMPTY_SETTINGS: Readonly<Record<string, EnvironmentPowerSettings>> = {};

export const environmentPowerSettingsAtom = Atom.make((get) => {
  const result = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.environmentPower ?? EMPTY_SETTINGS)
    : EMPTY_SETTINGS;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:environment-power:settings"));

/** Environments whose status the home power chip owns while they are not connected. */
export const powerManagedEnvironmentIdsAtom = Atom.make(
  (get): ReadonlySet<EnvironmentId> =>
    new Set(Object.keys(get(environmentPowerSettingsAtom)) as EnvironmentId[]),
).pipe(Atom.keepAlive, Atom.withLabel("mobile:environment-power:managed-ids"));
