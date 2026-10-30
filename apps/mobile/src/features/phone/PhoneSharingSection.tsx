import { useAuth } from "@clerk/expo";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatConnectReachable, type EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { usePhoneSharingRecord } from "../../state/phone-server-settings";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { PHONE_STILL_LISTED, type PhoneSharing } from "./phone-sharing";
import {
  checkPhoneReachability,
  readPhoneSharing,
  reconcilePhoneSharing,
  sharePhone,
  stopPhoneSharing,
} from "./phone-sharing-commands";

function failureText(result: { readonly cause: Cause.Cause<unknown> }, fallback: string): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function sharingText(sharing: PhoneSharing, accountId: string | null | undefined): string {
  if (!sharing.shared) return "Off. Only the app on this phone can open its threads.";
  if (sharing.revoked) {
    return "T3 Connect no longer accepts this link, but its tunnel may still be set up here. Turn this off to clear it.";
  }
  if (sharing.cloudUserId !== null && sharing.cloudUserId !== accountId) {
    return "Shared with a different T3 Connect account. Turn this off to stop it.";
  }
  const reachability = sharing.reachability;
  if (reachability?.status === "unreachable") {
    return `On, but other devices can't connect yet: ${reachability.reason}`;
  }
  return reachability?.status === "reachable"
    ? `On. ${formatConnectReachable(reachability)}.`
    : "On. Devices signed in to your T3 Connect account can use this phone's server.";
}

/** Phone setup and the phone's environment page: share the phone's server through T3 Connect. */
export function PhoneSharingSection(props: { readonly environmentId: EnvironmentId }) {
  // useAuth needs the ClerkProvider, which builds without cloud config don't render.
  return hasCloudPublicConfig() ? (
    <ConfiguredPhoneSharingSection key={props.environmentId} {...props} />
  ) : null;
}

function ConfiguredPhoneSharingSection(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const preferences = useAtomValue(mobilePreferencesAtom);
  const record = usePhoneSharingRecord();
  const stopUnfinished = record?.phase === "stopping";
  const connection = useSavedRemoteConnection(props.environmentId);
  const connected =
    useWorkspaceEnvironments().find((candidate) => candidate.environmentId === props.environmentId)
      ?.connectionState === "connected";
  const [sharing, setSharing] = useState<PhoneSharing | null>(null);
  const [busy, setBusy] = useState<"share" | "stop" | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Only the newest read or action may show its result, and reads wait out a share or stop.
  const latest = useRef(0);
  const acting = useRef(false);

  const check = useCallback(() => {
    if (connection === null || !connected || acting.current) return;
    latest.current += 1;
    const id = latest.current;
    setVerifying(false);
    void runAtomCommand(appAtomRegistry, readPhoneSharing, connection, {
      reportFailure: false,
    }).then((result) => {
      if (id !== latest.current) return;
      if (AsyncResult.isSuccess(result)) {
        setReadError(null);
        setSharing(result.value);
        if (!result.value.shared) void reconcilePhoneSharing();
      } else {
        setReadError(failureText(result, "Couldn't check whether this phone is shared."));
      }
    });
  }, [connection, connected]);
  useFocusEffect(check);

  if (connection === null) return null;

  // The switch can turn sharing off during this wait, which discards the result.
  const verify = () => {
    latest.current += 1;
    const id = latest.current;
    setVerifying(true);
    void runAtomCommand(appAtomRegistry, checkPhoneReachability, connection, {
      reportFailure: false,
    }).then((result) => {
      if (id !== latest.current) return;
      setVerifying(false);
      const reachability = AsyncResult.isSuccess(result) ? result.value : null;
      setSharing((current) => (current?.shared ? { ...current, reachability } : current));
    });
  };

  const finish = () => {
    acting.current = false;
    setBusy(null);
  };

  const share = async () => {
    const token = userId ? await getToken(resolveRelayClerkTokenOptions()).catch(() => null) : null;
    if (!token || !userId) {
      setActionError("Couldn't get a T3 Connect sign-in. Sign in again under Settings.");
      finish();
      return;
    }
    const failure = await sharePhone({
      connection,
      accountId: userId,
      clerkToken: token,
      liveActivitiesEnabled:
        !AsyncResult.isSuccess(preferences) || preferences.value.liveActivitiesEnabled !== false,
    });
    finish();
    refreshManagedRelayEnvironments();
    if (failure === null) {
      setSharing({ shared: true, revoked: false, cloudUserId: userId, reachability: null });
      verify();
    } else {
      setActionError(failure);
      check();
    }
  };

  const stopSharing = async () => {
    setActionError(await stopPhoneSharing());
    finish();
    refreshManagedRelayEnvironments();
    check();
  };

  const run = (kind: "share" | "stop", action: () => Promise<void>) => {
    acting.current = true;
    latest.current += 1;
    setBusy(kind);
    setVerifying(false);
    setActionError(null);
    void action();
  };

  const onValueChange = (on: boolean) => {
    if (!on) {
      Dialog.alert(
        "Stop sharing this phone?",
        "Stops the tunnel and signs out every other device, so they lose access to this phone's server. Your threads stay here, and so does anything another device changed or installed while it was shared.",
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
      "Anyone signed in to your T3 Connect account gets full control of this phone's server: threads, agents, a terminal running as root in its Ubuntu, and your phone's files if you've allowed phone storage. They can also use commands such as the clipboard and notifications.\n\nAgent access covers what agents normally do on your phone, but it isn't a hard barrier against someone using that terminal. Share only with an account you fully trust.\n\nThe phone counts as one of your account's T3 Connect machines. The first time, T3 Code downloads Cloudflare's tunnel client (about 40 MB).",
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
        actionError ??
        readError ??
        "The server listens only on this phone, so nothing on your network can connect to it directly. While it's shared, a tunnel gives it a public T3 Connect address, and connecting takes a sign-in to the account it's shared with."
      }
    >
      <SettingsSwitchRow
        icon="cloud"
        label="Share with your other devices"
        subtitle={
          !connected
            ? "Start the server on this phone first."
            : busy === "share"
              ? "Sharing…"
              : busy === "stop"
                ? "Stopping…"
                : stopUnfinished
                  ? "Still stopping. Other devices may have access until this finishes. Turn this off to try again."
                  : verifying
                    ? "On. Checking that other devices can connect, for up to a minute."
                    : sharing === null
                      ? readError === null
                        ? "Checking…"
                        : "Couldn't check."
                      : !sharing.shared && record?.phase === "listed"
                        ? `Off. ${PHONE_STILL_LISTED}`
                        : sharingText(sharing, userId)
        }
        value={sharing?.shared === true || stopUnfinished}
        disabled={!connected || busy !== null || sharing === null}
        onValueChange={onValueChange}
      />
    </SettingsSection>
  );
}
