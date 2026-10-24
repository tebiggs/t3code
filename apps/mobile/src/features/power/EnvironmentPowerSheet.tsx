import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  POWER_STATUS_LABELS,
  countActiveThreads,
  powerStatus,
  sleepTarget,
  wakeTarget,
  type PowerStatus,
  type PowerTarget,
} from "./environment-power";
import {
  sleepEnvironment,
  useEnvironmentPowerRuntime,
  useEnvironmentPowerSettings,
  wakeEnvironment,
} from "./environment-power-state";
import { PowerStatusGlyph } from "./EnvironmentPowerChips";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function EnvironmentPowerSheet({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const { environmentId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environments = useWorkspaceEnvironments();
  const settings = useEnvironmentPowerSettings()[environmentId];
  const runtime = useEnvironmentPowerRuntime(environmentId);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const label = environment?.environmentLabel ?? "Environment";
  const status: PowerStatus = environment
    ? powerStatus(runtime, {
        phase: environment.connectionState,
        error: environment.connectionError,
      })
    : "checking";

  // Why the next action can't run right now, or null when it can.
  const blocker = (target: PowerTarget): string | null => {
    if ("error" in target) return target.error;
    const runner = environments.find((entry) => entry.environmentId === target.environmentId);
    return runner?.isEnabled === true && runner.connectionState === "connected"
      ? null
      : `${runner?.environmentLabel ?? "The machine that sends it"} isn't connected.`;
  };
  const busy = status === "waking" || status === "sleeping";
  const notice =
    settings === undefined
      ? null
      : status === "asleep"
        ? blocker(wakeTarget(settings))
        : status === "awake"
          ? blocker(sleepTarget(environmentId, settings))
          : null;
  const canToggle =
    settings !== undefined &&
    !busy &&
    (status === "awake" || status === "asleep") &&
    notice === null;

  const detail = (() => {
    switch (status) {
      case "awake":
        return "Connected";
      case "asleep":
        return runtime.asleepSince === null
          ? "Not reachable"
          : `Not reachable since ${formatTime(runtime.asleepSince)}`;
      case "waking":
        return "Wake sent. Waiting for it to connect…";
      case "sleeping":
        return "Asking it to sleep…";
      case "checking":
        return "Checking whether it's awake…";
      case "offline":
        return "Your phone is offline.";
    }
  })();

  const requestSleep = () => {
    const active = countActiveThreads(
      appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
      environmentId,
    );
    if (active === 0) {
      void sleepEnvironment(environmentId);
      return;
    }
    Dialog.alert(
      `Put ${label} to sleep?`,
      `${active === 1 ? "1 thread is" : `${active} threads are`} still working on ${label}. Sleeping will interrupt ${active === 1 ? "it" : "them"}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sleep",
          style: "destructive",
          onPress: () => void sleepEnvironment(environmentId),
        },
      ],
    );
  };

  const openSettings = () =>
    navigation.dispatch(
      StackActions.replace("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsEnvironmentDetail", params: { environmentId } },
      }),
    );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title={label} onBack={() => navigation.goBack()} />
      <View className="gap-3 px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
        <View className="flex-row items-center gap-3.5 rounded-2xl bg-card py-3.5 pl-4 pr-3.5">
          <View className="size-10 items-center justify-center rounded-xl bg-subtle">
            <PowerStatusGlyph status={status} size={20} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-bold text-foreground">
              {POWER_STATUS_LABELS[status]}
            </Text>
            <Text textRole="label" className="text-foreground-muted">
              {detail}
            </Text>
          </View>
          <ThemedSwitch
            accessibilityLabel={`${label} awake`}
            disabled={!canToggle}
            value={status === "awake" || status === "waking"}
            onValueChange={(awake) => {
              if (awake) void wakeEnvironment(environmentId);
              else requestSleep();
            }}
          />
        </View>
        {runtime.error ? (
          <Text selectable textRole="label" className="px-1 text-danger-foreground">
            {runtime.error}
          </Text>
        ) : null}
        {notice ? (
          <Text textRole="label" className="px-1 text-warning-foreground">
            {notice}
          </Text>
        ) : null}
        <Text textRole="label" className="px-1 text-foreground-muted">
          {status === "asleep"
            ? "Turn on to wake it. It usually answers in about 10 seconds, or a minute or more after a full shutdown."
            : "Turn off to put it to sleep. While it's asleep, T3 Code won't try to reconnect."}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={openSettings}
          className="self-start px-1 py-2 active:opacity-70"
        >
          <Text textRole="footnote" className="font-t3-medium text-primary-text">
            Power settings
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
