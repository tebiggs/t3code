import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { POWER_STATUS_LABELS, powerStatus, type PowerStatus } from "./environment-power";
import { useEnvironmentPowerRuntime, useEnvironmentPowerSettings } from "./environment-power-state";

/** Home-screen chips for environments with sleep/wake control. Renders nothing when none are set up. */
export function EnvironmentPowerChips() {
  const settings = useEnvironmentPowerSettings();
  const environments = useWorkspaceEnvironments();
  const navigation = useNavigation();
  const managed = environments.filter(
    (environment) => environment.isEnabled && settings[environment.environmentId] !== undefined,
  );
  if (managed.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2 px-5 pb-2.5">
      {managed.map((environment) => (
        <EnvironmentPowerChip
          key={environment.environmentId}
          environment={environment}
          onPress={(environmentId) => navigation.navigate("EnvironmentPower", { environmentId })}
        />
      ))}
    </View>
  );
}

function EnvironmentPowerChip(props: {
  readonly environment: WorkspaceEnvironment;
  readonly onPress: (environmentId: EnvironmentId) => void;
}) {
  const runtime = useEnvironmentPowerRuntime(props.environment.environmentId);
  const status = powerStatus(runtime, {
    phase: props.environment.connectionState,
    error: props.environment.connectionError,
  });
  const label = POWER_STATUS_LABELS[status];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.environment.environmentLabel}, ${label}`}
      accessibilityHint="Opens sleep and wake controls"
      onPress={() => props.onPress(props.environment.environmentId)}
      className="h-8 flex-row items-center gap-1.5 rounded-lg border border-border bg-subtle pl-2.5 pr-2 active:opacity-70"
    >
      <PowerStatusGlyph status={status} />
      <Text
        textRole="footnote"
        numberOfLines={1}
        className="max-w-[160px] font-t3-medium text-foreground"
      >
        {props.environment.environmentLabel}
      </Text>
      <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
        {label}
      </Text>
      <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

export function PowerStatusGlyph(props: { readonly status: PowerStatus; readonly size?: number }) {
  const size = props.size ?? 14;
  switch (props.status) {
    case "awake":
      return <ConnectionStatusDot state="connected" pulse={false} size={Math.round(size / 2)} />;
    case "asleep":
      return <SymbolView name="moon" size={size} tintColorClassName="accent-icon-muted" />;
    case "offline":
      return <SymbolView name="wifi.slash" size={size} tintColorClassName="accent-icon-muted" />;
    case "waking":
    case "sleeping":
    case "checking":
      return <AppActivityIndicator size={size} />;
  }
}
