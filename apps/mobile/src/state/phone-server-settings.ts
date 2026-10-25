import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

import type { PhoneServerSettings } from "../persistence/mobile-preferences";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";

export const phoneServerSettingsAtom = Atom.make((get): PhoneServerSettings | null => {
  const result = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? (result.value.phoneServer ?? null) : null;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:phone-server:settings"));

export function setPhoneServerSettings(settings: PhoneServerSettings | null) {
  appAtomRegistry.set(updateMobilePreferencesAtom, { phoneServer: settings });
}

export function usePhoneServerSettings(): PhoneServerSettings | null {
  return useAtomValue(phoneServerSettingsAtom);
}
