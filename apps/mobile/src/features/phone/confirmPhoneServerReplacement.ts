import { formatConjunctionList } from "@t3tools/client-runtime/list-format";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { replacedPhoneEnvironments } from "./phone-server";

/**
 * Asks before connecting removes the environments of the phone's other server, such as one
 * from Termux setup, then runs `connect`.
 */
export function confirmPhoneServerReplacement(port: number, locale: string, connect: () => void) {
  const replaced = replacedPhoneEnvironments(port);
  if (replaced.length === 0) {
    connect();
    return;
  }
  const names = formatConjunctionList(
    replaced.map((environment) => environment.environmentLabel),
    locale,
    m,
  );
  Dialog.alert(
    m(msg("Replace this phone's other server?")),
    m(
      msg(
        "Connecting removes {names} from your environments. If Termux still runs that server, stop it there or uninstall Termux; its threads stay in Termux.",
        { names },
      ),
    ),
    [
      { text: m(msg("Cancel")), style: "cancel" },
      { text: m(msg("Replace")), style: "destructive", onPress: connect },
    ],
  );
}
