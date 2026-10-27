import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { deviceRuntime, type DeviceRuntimeState, type DeviceRuntimeStatus } from "./device-runtime";

const VISIBLE_LINES = 300;

interface PrototypeReport {
  readonly failure: string | null;
  readonly totalSeconds: number;
  readonly steps: ReadonlyArray<{
    readonly title: string;
    readonly seconds: number;
    readonly downloadedBytes: number;
    readonly rootfsBytes?: number;
    readonly exitCode: number;
  }>;
}

function megabytes(bytes: number | undefined): string {
  return bytes === undefined ? "?" : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Phase 1 of the on-device runtime: runs Ubuntu, Node.js and Claude Code without Termux. */
export function DeviceRuntimePrototypeScreen() {
  if (deviceRuntime === null) {
    return (
      <SettingsScreen title="On-device runtime">
        <Text className="px-7 pt-4 text-sm text-foreground-muted">Needs the Android app.</Text>
      </SettingsScreen>
    );
  }
  return <Prototype native={deviceRuntime} />;
}

function Prototype({ native }: { readonly native: NonNullable<typeof deviceRuntime> }) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<DeviceRuntimeStatus>(() => native.getStatus());
  const [lines, setLines] = useState<ReadonlyArray<string>>(() => status.log);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- follows the native runner's log and state
  useEffect(() => {
    const log = native.addListener("onLog", (event) =>
      setLines((previous) => [...previous, ...event.lines].slice(-VISIBLE_LINES)),
    );
    const state = native.addListener("onState", (next: DeviceRuntimeState) =>
      setStatus((previous) => (next.running ? { ...previous, ...next } : native.getStatus())),
    );
    return () => {
      log.remove();
      state.remove();
    };
  }, [native]);

  const report = status.report ? (JSON.parse(status.report) as PrototypeReport) : null;
  const start = () => {
    setError(null);
    setLines([]);
    if (!native.startPrototype()) setError("The prototype is already running.");
    setStatus(native.getStatus());
  };
  const reset = () => {
    setError(null);
    native
      .reset()
      .then(() => setStatus(native.getStatus()))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <SettingsScreen title="On-device runtime">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Prototype: downloads Ubuntu into this app and installs Node.js and Claude Code there,
          without Termux. Uses about 700 MB. Keep the app open while it runs.
        </Text>
        {!status.supported ? (
          <Text className="px-2 text-sm text-danger-foreground">
            This phone isn't 64-bit ARM, or the APK has no proot.
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          {status.running ? (
            <Button label="Stop" tone="danger" onPress={() => native.cancel()} />
          ) : (
            <Button
              label={status.ubuntuInstalled ? "Run again" : "Run prototype"}
              tone="primary"
              disabled={!status.supported}
              onPress={start}
            />
          )}
          {status.ubuntuInstalled && !status.running ? (
            <Button label="Delete Ubuntu" tone="text" onPress={reset} />
          ) : null}
        </View>
        {status.running && status.stepTitle ? (
          <Text className="px-2 text-sm font-t3-medium text-foreground">{status.stepTitle}</Text>
        ) : null}
        {error || status.failure ? (
          <Text selectable className="px-2 text-sm text-danger-foreground">
            {error ?? status.failure}
          </Text>
        ) : null}
        {report ? (
          <View className="gap-1 px-2">
            {report.steps.map((step) => (
              <Text key={step.title} selectable className="text-xs text-foreground">
                {step.exitCode === 0 ? "✓" : "✗"} {step.title}: {step.seconds.toFixed(0)} s, ↓
                {megabytes(step.downloadedBytes)}, disk {megabytes(step.rootfsBytes)}
              </Text>
            ))}
            <Text className="text-xs text-foreground-muted">
              Total {report.totalSeconds.toFixed(0)} s
            </Text>
          </View>
        ) : null}
        <Text selectable className="px-2 font-mono text-[11px] leading-4 text-foreground-muted">
          {lines.join("\n")}
        </Text>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
