import { useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { DeviceRuntimeSetupScreen } from "../device-runtime/DeviceRuntimeSetupScreen";
import { supportsDeviceRuntime } from "../device-runtime/device-runtime";
import { SettingsScreen } from "../settings/components/SettingsScreen";

/** Deep links reach this route on iOS too, where nothing runs on the phone itself. */
export function PhoneSetupRouteScreen() {
  const [supported] = useState(supportsDeviceRuntime);
  return supported ? <DeviceRuntimeSetupScreen /> : <PhoneSetupUnavailable />;
}

function PhoneSetupUnavailable() {
  return (
    <SettingsScreen title="Run on this phone">
      <Text className="px-7 pt-4 text-sm text-foreground-muted">
        Running agents on the phone itself needs the Android app on a 64-bit phone.
      </Text>
    </SettingsScreen>
  );
}
