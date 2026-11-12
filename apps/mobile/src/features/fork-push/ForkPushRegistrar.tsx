import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { forkPushEnvironment } from "./forkPushState";
import { supportsForkPush } from "./nativeOwnership";
import { startForkPushRegistration } from "./registrar";

/** Registers this phone with whichever connected environment holds the fork's FCM key. */
export function ForkPushRegistrar() {
  const environments = useWorkspaceEnvironments();
  if (!supportsForkPush()) return null;
  return environments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => (
      <PushHostProbe key={environment.environmentId} environmentId={environment.environmentId} />
    ));
}

function PushHostProbe(props: { readonly environmentId: EnvironmentId }) {
  const status = useEnvironmentQuery(
    forkPushEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  const isHost = status.data?.role === "host";
  const register = useAtomCommand(forkPushEnvironment.register, { reportFailure: false });
  const start = useEffectEvent(() =>
    startForkPushRegistration(props.environmentId, async (input) => {
      const result = await register({ environmentId: props.environmentId, input });
      return result._tag === "Success"
        ? { ok: true }
        : { ok: false, error: String(squashAtomCommandFailure(result)) };
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registration with the push host follows which connected environment is the host
  useEffect(() => {
    if (!isHost) return;
    return start();
  }, [isHost]);
  return null;
}
