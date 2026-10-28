import * as Dialog from "../../components/ui/Dialog";
import { DEVICE_SERVER_PORT } from "../device-runtime/device-runtime";
import { replacedPhoneEnvironments } from "./phone-server";
import { phoneServerPort } from "./phone-setup";

/** Asks before a server on `port` replaces the phone's other one, then runs `connect`. */
export function confirmPhoneServerReplacement(port: number, connect: () => void) {
  const replaced = replacedPhoneEnvironments(port);
  if (replaced.length === 0) {
    connect();
    return;
  }
  const names = replaced
    .map(
      (environment) =>
        `${environment.environmentLabel} ${phoneServerPort(environment.displayUrl) === DEVICE_SERVER_PORT ? "inside T3 Code" : "in Termux"}`,
    )
    .join(" and ");
  Dialog.alert(
    "Replace this phone's other server?",
    `This phone runs one T3 Code server at a time. Connecting stops ${names} and removes it from your environments. Its threads stay on the phone; set it up again to see them.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: connect },
    ],
  );
}
