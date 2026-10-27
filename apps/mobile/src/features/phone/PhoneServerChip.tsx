import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { usePhoneServerSettings } from "../../state/phone-server-settings";
import { startAndReconnectPhoneServer, usePhoneServerRuntime } from "./phone-server";

/**
 * Home-screen chip while this phone's own server is down: tap to start it, or to open
 * setup when starting failed. Renders nothing while it's connected or not set up.
 */
export function PhoneServerChip(props: { readonly className?: string }) {
  const navigation = useNavigation();
  const settings = usePhoneServerSettings();
  const runtime = usePhoneServerRuntime();
  const phone = useWorkspaceEnvironments().find(
    (environment) => environment.environmentId === settings?.environmentId,
  );
  if (settings === null || !phone?.isEnabled) return null;
  if (phone.connectionState === "connected" || phone.connectionState === "connecting") return null;
  const label = runtime.starting ? "Starting…" : runtime.error ? "Can't start" : "Stopped";

  return (
    <View className={cn("flex-row px-5 pb-2.5", props.className)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${phone.environmentLabel}, ${label}`}
        accessibilityHint={runtime.error ? "Opens phone setup" : "Starts the server in Termux"}
        disabled={runtime.starting}
        onPress={() => {
          if (runtime.error) navigation.navigate("PhoneSetup");
          else void startAndReconnectPhoneServer(settings);
        }}
        className="h-8 flex-row items-center gap-1.5 rounded-lg border border-border bg-subtle pl-2.5 pr-2 active:opacity-70"
      >
        {runtime.starting ? (
          <AppActivityIndicator size={14} />
        ) : (
          <SymbolView
            name={runtime.error ? "exclamationmark.triangle" : "iphone"}
            size={14}
            tintColorClassName="accent-icon-muted"
          />
        )}
        <Text
          textRole="footnote"
          numberOfLines={1}
          className="max-w-[160px] font-t3-medium text-foreground"
        >
          {phone.environmentLabel}
        </Text>
        <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
          {label}
        </Text>
        {runtime.starting ? null : (
          <SymbolView
            name={runtime.error ? "chevron.right" : "play"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
        )}
      </Pressable>
    </View>
  );
}
