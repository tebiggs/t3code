import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useMemo } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { forkPushEnvironment } from "./forkPushState";
import { supportsForkPush } from "./nativeOwnership";
import { syncForkPushHosts } from "./registrar";

/** Registers this phone with a connected environment that holds the fork's FCM key. */
export function ForkPushRegistrar() {
  const connectedKey = useWorkspaceEnvironments()
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .sort()
    .join("\n");
  const hostsAtom = useMemo(() => {
    const connected = connectedKey === "" ? [] : connectedKey.split("\n");
    return Atom.make((get) =>
      connected
        .filter(
          (environmentId) =>
            AsyncResult.getOrElse(
              get(
                forkPushEnvironment.status({
                  environmentId: EnvironmentId.make(environmentId),
                  input: {},
                }),
              ),
              () => null,
            )?.role === "host",
        )
        .join("\n"),
    );
  }, [connectedKey]);
  const hostsKey = useAtomValue(hostsAtom);
  const register = useAtomCommand(forkPushEnvironment.register, { reportFailure: false });
  const sync = useEffectEvent((key: string) => {
    if (!supportsForkPush()) return;
    syncForkPushHosts(
      key === "" ? [] : key.split("\n").map((environmentId) => EnvironmentId.make(environmentId)),
      async (environmentId, input) => {
        const result = await register({ environmentId, input });
        return result._tag === "Success"
          ? { ok: true }
          : { ok: false, error: String(squashAtomCommandFailure(result)) };
      },
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registration with the push host follows which connected environments are hosts
  useEffect(() => {
    sync(hostsKey);
  }, [hostsKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an unmounted registrar leaves no registration running
  useEffect(() => () => sync(""), []);
  return null;
}
