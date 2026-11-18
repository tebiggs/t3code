import { useAuth } from "@clerk/expo";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  formatConnectReachable,
  type EnvironmentId,
  type EnvironmentSharingMode,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useCallback, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { m as mNow, type MessageResolver } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { usePhoneSharingRecord } from "../../state/phone-server-settings";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PHONE_STILL_LISTED, type PhoneSharing } from "./phone-sharing";
import {
  changePhoneSharingMode,
  checkPhoneReachability,
  readPhoneSharing,
  reconcilePhoneSharing,
  sharePhone,
  stopPhoneSharing,
} from "./phone-sharing-commands";

type SharingChoice = "off" | EnvironmentSharingMode;

const SHARING_CHOICES = [
  { value: "off", label: msg("Off", { $context: "sharing is turned off" }) },
  { value: "view-only", label: msg("View only") },
  { value: "full-control", label: msg("Full control") },
] as const;

const MODE_LABEL = { "view-only": msg("View only"), "full-control": msg("Full control") } as const;

const VIEW_ONLY_WARNING = msg(
  "Anyone signed in to your T3 Connect account can read this phone's threads, including any secrets in them, such as a token an agent printed. They can also see its projects, its pull requests and any open preview.\n\nThey can't send messages, answer approvals, or use the terminal or files. Only this phone can do that.",
);

const FULL_CONTROL_WARNING = msg(
  "Anyone signed in to your T3 Connect account gets full control of this phone's server: threads, agents, a terminal running as root in its Ubuntu, and your phone's files if you've allowed phone storage. They can also use commands such as the clipboard and notifications.\n\nAgent access covers what agents normally do on your phone, but it isn't a hard barrier against someone using that terminal. Share only with an account you fully trust.",
);

const FIRST_SHARE_NOTE = msg(
  "The phone counts as one of your account's T3 Connect machines. The first time, T3 Code downloads Cloudflare's tunnel client (about 40 MB).",
);

function failureText(result: { readonly cause: Cause.Cause<unknown> }, fallback: string): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function sharingText(
  sharing: PhoneSharing,
  accountId: string | null | undefined,
  resolve: MessageResolver = mNow,
): string {
  if (!sharing.shared) return resolve(msg("Off. Only the app on this phone can open its threads."));
  if (sharing.revoked) {
    return resolve(
      msg(
        "T3 Connect no longer accepts this link, but its tunnel may still be set up here. Turn this off to clear it.",
      ),
    );
  }
  const mode = resolve(MODE_LABEL[sharing.mode]);
  if (sharing.modeChangePending) {
    return resolve(
      msg(
        "{mode} is set, but devices signed in before the change may keep their old access. Tap {mode} to try again.",
        { mode },
      ),
    );
  }
  if (sharing.cloudUserId !== null && sharing.cloudUserId !== accountId) {
    return resolve(msg("Shared with a different T3 Connect account. Turn this off to stop it."));
  }
  const reachability = sharing.reachability;
  if (reachability?.status === "unreachable") {
    return resolve(
      msg("{mode}, but other devices can't connect yet: {reason}", {
        mode,
        reason: reachability.reason,
      }),
    );
  }
  if (reachability?.status === "reachable") {
    return resolve(
      msg("{mode}. {reachability}.", {
        mode,
        reachability: formatConnectReachable(reachability),
      }),
    );
  }
  return sharing.mode === "view-only"
    ? resolve(
        msg(
          "View only. Devices signed in to your T3 Connect account can read this phone's threads.",
        ),
      )
    : resolve(
        msg(
          "Full control. Devices signed in to your T3 Connect account can use this phone's server.",
        ),
      );
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
  const gt = useGT();
  const m = useMessages();
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const preferences = useAtomValue(mobilePreferencesAtom);
  const record = usePhoneSharingRecord();
  const stopUnfinished = record?.phase === "stopping";
  const connection = useSavedRemoteConnection(props.environmentId);
  const connected =
    useWorkspaceEnvironments().find((candidate) => candidate.environmentId === props.environmentId)
      ?.connectionState === "connected";
  const [sharing, setSharing] = useState<PhoneSharing | null>(null);
  const [busy, setBusy] = useState<"share" | "stop" | "mode" | null>(null);
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
        setReadError(failureText(result, gt("Couldn't check whether this phone is shared.")));
      }
    });
  }, [connection, connected, gt]);
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

  const share = async (mode: EnvironmentSharingMode) => {
    const token = userId ? await getToken(resolveRelayClerkTokenOptions()).catch(() => null) : null;
    if (!token || !userId) {
      setActionError(gt("Couldn't get a T3 Connect sign-in. Sign in again under Settings."));
      finish();
      return;
    }
    const failure = await sharePhone({
      connection,
      accountId: userId,
      clerkToken: token,
      liveActivitiesEnabled:
        !AsyncResult.isSuccess(preferences) || preferences.value.liveActivitiesEnabled !== false,
      mode,
    });
    finish();
    refreshManagedRelayEnvironments();
    if (failure === null) {
      setSharing({
        shared: true,
        revoked: false,
        cloudUserId: userId,
        reachability: null,
        mode,
        modeChangePending: false,
      });
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

  const changeMode = async (mode: EnvironmentSharingMode) => {
    const failure = await changePhoneSharingMode(connection, mode);
    setActionError(failure);
    // The server took it, so a failed read below mustn't leave the old mode on screen.
    if (failure === null) {
      setSharing((current) =>
        current?.shared ? { ...current, mode, modeChangePending: false } : current,
      );
    }
    finish();
    check();
  };

  const run = (kind: "share" | "stop" | "mode", action: () => Promise<void>) => {
    acting.current = true;
    latest.current += 1;
    setBusy(kind);
    setVerifying(false);
    setActionError(null);
    void action();
  };

  const selected: SharingChoice = sharing?.shared
    ? sharing.mode
    : // Mid-stop the server may still grant anything, so it doesn't read as off.
      stopUnfinished
      ? "full-control"
      : "off";
  const locked = !connected || busy !== null || sharing === null;

  const onSelect = (choice: SharingChoice) => {
    if (locked) return;
    if (choice === "off") {
      if (selected === "off") return;
      Dialog.alert(
        gt("Stop sharing this phone?"),
        gt(
          "Stops the tunnel and signs out every other device, so they lose access to this phone's server. Your threads stay here, and so does anything another device changed or installed while it was shared.",
        ),
        [
          { text: gt("Cancel"), style: "cancel" },
          {
            text: gt("Stop sharing"),
            style: "destructive",
            onPress: () => run("stop", stopSharing),
          },
        ],
      );
      return;
    }
    if (selected === "off") {
      if (!isSignedIn) {
        Dialog.alert(
          gt("Sign in to T3 Connect"),
          gt("Sharing uses your T3 Connect account. Sign in, then turn sharing on."),
          [
            { text: gt("Cancel"), style: "cancel" },
            { text: gt("Continue"), onPress: () => navigation.navigate("SettingsAuth") },
          ],
        );
        return;
      }
      Dialog.alert(
        choice === "view-only"
          ? gt("Share this phone View only?")
          : gt("Give full control of this phone?"),
        [
          m(choice === "view-only" ? VIEW_ONLY_WARNING : FULL_CONTROL_WARNING),
          m(FIRST_SHARE_NOTE),
        ].join("\n\n"),
        [
          { text: gt("Cancel"), style: "cancel" },
          { text: gt("Share"), onPress: () => run("share", () => share(choice)) },
        ],
      );
      return;
    }
    if (!sharing?.shared) return;
    if (choice === selected) {
      if (sharing.modeChangePending) run("mode", () => changeMode(choice));
      return;
    }
    Dialog.alert(
      choice === "view-only" ? gt("Switch to View only?") : gt("Give full control of this phone?"),
      (choice === "view-only"
        ? [
            gt("Signs out every other device. When they reconnect they can only read."),
            m(VIEW_ONLY_WARNING),
            gt("Anything another device changed or installed while it had full control stays."),
          ]
        : [
            gt("Signs out every other device. When they reconnect they have full control."),
            m(FULL_CONTROL_WARNING),
          ]
      ).join("\n\n"),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: choice === "view-only" ? gt("Switch to View only") : gt("Give full control"),
          ...(choice === "view-only" ? {} : { style: "destructive" as const }),
          onPress: () => run("mode", () => changeMode(choice)),
        },
      ],
    );
  };

  const status = !connected
    ? gt("Start the server on this phone first.")
    : busy === "share"
      ? gt("Sharing…")
      : busy === "stop"
        ? gt("Stopping…")
        : busy === "mode"
          ? gt("Signing out other devices…")
          : stopUnfinished
            ? gt(
                "Still stopping. Other devices may have access until this finishes. Tap Off to try again.",
              )
            : verifying
              ? gt("On. Checking that other devices can connect, for up to a minute.")
              : sharing === null
                ? readError === null
                  ? gt("Checking…")
                  : gt("Couldn't check.")
                : !sharing.shared && record?.phase === "listed"
                  ? gt("Off. {detail}", { detail: PHONE_STILL_LISTED })
                  : sharingText(sharing, userId, m);

  return (
    <SettingsSection
      title={gt("Other devices")}
      footer={
        actionError ??
        readError ??
        gt(
          "The server listens only on this phone, so nothing on your network can connect to it directly. While it's shared, a tunnel gives it a public T3 Connect address, and connecting takes a sign-in to the account it's shared with.",
        )
      }
    >
      <View className="gap-3 p-4">
        <Text textRole="body">
          <T>Share with your other devices</T>
        </Text>
        <View className={locked ? "opacity-50" : undefined}>
          <SegmentedControl
            variant="card"
            options={SHARING_CHOICES.map((choice) => ({ ...choice, label: m(choice.label) }))}
            selected={selected}
            onSelect={onSelect}
          />
        </View>
        <Text textRole="footnote" className="text-foreground-muted">
          {status}
        </Text>
      </View>
    </SettingsSection>
  );
}
