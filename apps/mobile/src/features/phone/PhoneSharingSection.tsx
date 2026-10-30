import { useAuth } from "@clerk/expo";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatConnectReachable, type EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  readPhoneSharing,
  sharePhoneServer,
  stopSharingPhoneServer,
  type PhoneSharing,
} from "./phone-sharing";

function failureText(result: { readonly cause: Cause.Cause<unknown> }, fallback: string): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function sharingText(sharing: PhoneSharing | null): string {
  if (sharing === null) return "Checking…";
  if (!sharing.shared) return "Off. Only the app on this phone can open its threads.";
  const reachability = sharing.reachability;
  if (reachability?.status === "unreachable") {
    return `On, but other devices can't connect yet: ${reachability.reason}`;
  }
  return reachability?.status === "reachable"
    ? `On. ${formatConnectReachable(reachability)}.`
    : "On. Devices signed in to your T3 Connect account can open this phone's threads.";
}

/** Phone setup and the phone's environment page: share the phone's server through T3 Connect. */
export function PhoneSharingSection(props: { readonly environmentId: EnvironmentId }) {
  // useAuth needs the ClerkProvider, which builds without cloud config don't render.
  return hasCloudPublicConfig() ? <ConfiguredPhoneSharingSection {...props} /> : null;
}

function ConfiguredPhoneSharingSection(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const accountId = useAtomValue(managedRelaySessionAtom)?.accountId ?? null;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const connection = useSavedRemoteConnection(props.environmentId);
  const connected =
    useWorkspaceEnvironments().find((candidate) => candidate.environmentId === props.environmentId)
      ?.connectionState === "connected";
  const [sharing, setSharing] = useState<PhoneSharing | null>(null);
  const [busy, setBusy] = useState<"share" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(() => {
    if (connection === null || !connected) return;
    void runAtomCommand(appAtomRegistry, readPhoneSharing, connection, {
      reportFailure: false,
    }).then((result) => {
      if (AsyncResult.isSuccess(result)) setSharing(result.value);
      else setError(failureText(result, "Couldn't check whether this phone is shared."));
    });
  }, [connection, connected]);
  useFocusEffect(check);

  if (connection === null) return null;

  const share = async () => {
    const token = await getToken(resolveRelayClerkTokenOptions()).catch(() => null);
    if (!token) {
      setError("Couldn't get a T3 Connect sign-in. Sign in again under Settings.");
      return;
    }
    const result = await runAtomCommand(
      appAtomRegistry,
      sharePhoneServer,
      {
        connection,
        clerkToken: token,
        liveActivitiesEnabled:
          !AsyncResult.isSuccess(preferences) || preferences.value.liveActivitiesEnabled !== false,
      },
      { reportFailure: false },
    );
    if (AsyncResult.isSuccess(result)) {
      setSharing(result.value);
      refreshManagedRelayEnvironments();
    } else {
      setError(failureText(result, "Couldn't share this phone."));
      check();
    }
  };

  const stopSharing = async () => {
    const result = await runAtomCommand(
      appAtomRegistry,
      stopSharingPhoneServer,
      { connection, accountId },
      { reportFailure: false },
    );
    if (AsyncResult.isFailure(result)) setError(failureText(result, "Couldn't stop sharing."));
    refreshManagedRelayEnvironments();
    check();
  };

  const run = (kind: "share" | "stop", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    void action().finally(() => setBusy(null));
  };

  const onValueChange = (on: boolean) => {
    if (!on) {
      Dialog.alert(
        "Stop sharing this phone?",
        "Your other devices lose access to this phone's threads. The threads stay on this phone.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Stop sharing", style: "destructive", onPress: () => run("stop", stopSharing) },
        ],
      );
      return;
    }
    if (!isSignedIn) {
      Dialog.alert(
        "Sign in to T3 Connect",
        "Sharing uses your T3 Connect account. Sign in, then turn sharing on.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Continue", onPress: () => navigation.navigate("SettingsAuth") },
        ],
      );
      return;
    }
    Dialog.alert(
      "Share this phone?",
      "Anyone signed in to your T3 Connect account can open this phone's threads and run agents on it while its server runs. The phone counts as one of your account's T3 Connect machines. The first time, T3 Code downloads Cloudflare's tunnel client (about 40 MB).",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Share", onPress: () => run("share", share) },
      ],
    );
  };

  return (
    <SettingsSection
      title="Other devices"
      footer={
        error ??
        "Sharing goes through T3 Connect. The server still listens only on this phone; a tunnel connects out to T3 Connect, so nothing on your Wi-Fi or mobile network can reach it."
      }
    >
      <SettingsSwitchRow
        icon="cloud"
        label="Share with your other devices"
        subtitle={
          !connected
            ? "Start the server on this phone first."
            : busy === "share"
              ? "Sharing… Checking that other devices can connect takes up to a minute."
              : busy === "stop"
                ? "Stopping…"
                : sharing === null && error !== null
                  ? "Couldn't check."
                  : sharingText(sharing)
        }
        value={sharing?.shared === true}
        disabled={!connected || busy !== null || sharing === null}
        onValueChange={onValueChange}
      />
    </SettingsSection>
  );
}
