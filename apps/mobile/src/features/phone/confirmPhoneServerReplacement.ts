import * as Dialog from "../../components/ui/Dialog";
import { replacedPhoneEnvironments } from "./phone-server";

/**
 * Asks before connecting removes the environments of the phone's other server, such as one
 * from Termux setup, then runs `connect`.
 */
export function confirmPhoneServerReplacement(port: number, connect: () => void) {
  const replaced = replacedPhoneEnvironments(port);
  if (replaced.length === 0) {
    connect();
    return;
  }
  const names = replaced.map((environment) => environment.environmentLabel).join(" and ");
  Dialog.alert(
    "Replace this phone's other server?",
    `Connecting removes ${names} from your environments. If Termux still runs that server, stop it there or uninstall Termux; its threads stay in Termux.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: connect },
    ],
  );
}
