import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import type { PhoneServerSettings, PhoneSharingRecord } from "../persistence/mobile-preferences";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, saveMobilePreferences } from "./preferences";

export const phoneServerSettingsAtom = Atom.make((get): PhoneServerSettings | null => {
  const result = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? (result.value.phoneServer ?? null) : null;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:phone-server:settings"));

export function setPhoneServerSettings(settings: PhoneServerSettings | null) {
  void runAtomCommand(appAtomRegistry, saveMobilePreferences, { phoneServer: settings });
}

export function usePhoneServerSettings(): PhoneServerSettings | null {
  return useAtomValue(phoneServerSettingsAtom);
}

export const phoneSharingRecordAtom = Atom.make((get): PhoneSharingRecord | null => {
  const result = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? (result.value.phoneSharing ?? null) : null;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:phone-sharing:record"));

export const savePhoneSharingRecord = (record: PhoneSharingRecord | null) =>
  saveMobilePreferences.run(appAtomRegistry, { phoneSharing: record });

export function usePhoneSharingRecord(): PhoneSharingRecord | null {
  return useAtomValue(phoneSharingRecordAtom);
}
