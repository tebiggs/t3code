import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import type { PhoneSharingRecord } from "../../persistence/mobile-preferences";
import { PHONE_STILL_LISTED, type PhoneSharing } from "./phone-sharing";
import { createPhoneSharingController } from "./phone-sharing-controller";

const environmentId = EnvironmentId.make("phone");
const connection = {
  environmentId,
  environmentLabel: "Phone",
  pairingUrl: "http://127.0.0.1:3774/",
  displayUrl: "http://127.0.0.1:3774/",
  httpBaseUrl: "http://127.0.0.1:3774/",
  wsBaseUrl: "ws://127.0.0.1:3774/",
  bearerToken: "local-bearer",
};
const shared = (cloudUserId: string | null): PhoneSharing => ({
  shared: true,
  revoked: false,
  cloudUserId,
  reachability: null,
});

function setup(initial: PhoneSharingRecord | null = null) {
  const state = {
    record: initial,
    account: "user_a" as string | null,
    connected: true,
    sharing: { shared: false } as PhoneSharing | null,
    stopFailure: null as string | null,
    deregisterFailure: null as string | null,
  };
  const stopOnServer = vi.fn(
    async (_connection: unknown, _options: { readonly revokeAccess: boolean }) => {
      if (state.stopFailure === null) state.sharing = { shared: false };
      return state.stopFailure;
    },
  );
  const deregister = vi.fn(async () => state.deregisterFailure);
  const controller = createPhoneSharingController({
    hydrated: async () => undefined,
    loadRecord: () => state.record,
    saveRecord: (record) => {
      state.record = record;
    },
    phoneEnvironmentId: () => environmentId,
    connectionFor: () => (state.connected ? connection : null),
    signedInAccount: () => state.account,
    readSharing: async () => (state.connected ? state.sharing : null),
    ensureRelayClient: async () => null,
    stopOnServer,
    deregister,
  });
  return { state, controller, stopOnServer, deregister };
}

const on: PhoneSharingRecord = { environmentId, accountId: "user_a", phase: "on" };

describe("createPhoneSharingController", () => {
  it("undoes a share when the account signs out while it's linking", async () => {
    const { state, controller, stopOnServer } = setup();
    let finishLink = (_failure: string | null) => {};
    const sharing = controller.share(
      connection,
      "user_a",
      () =>
        new Promise((resolve) => {
          finishLink = resolve;
        }),
    );
    const stopping = (async () => {
      await vi.waitFor(() => expect(state.record?.phase).toBe("on"));
      state.account = null;
      const stopped = controller.stop();
      state.sharing = shared("user_a");
      finishLink(null);
      return stopped;
    })();
    expect(await sharing).toContain("signed out");
    await stopping;
    expect(stopOnServer).toHaveBeenCalled();
    expect(state.sharing).toEqual({ shared: false });
  });

  it("keeps Off open until signing out other clients succeeds", async () => {
    const { state, controller, stopOnServer, deregister } = setup(on);
    state.sharing = shared("user_a");
    state.stopFailure = "other devices couldn't be signed out";

    expect(await controller.stop()).toBe("other devices couldn't be signed out");
    expect(state.record?.phase).toBe("stopping");
    expect(deregister).not.toHaveBeenCalled();

    // The server now reads as off, which must not end the retry.
    state.sharing = { shared: false };
    state.stopFailure = null;
    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).toHaveBeenCalledTimes(2);
    expect(stopOnServer).toHaveBeenLastCalledWith(connection, { revokeAccess: true });
    expect(deregister).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("finishes a sign-out's stop once the server answers, leaving the listing for the account", async () => {
    const { state, controller, stopOnServer, deregister } = setup(on);
    state.account = null;
    state.connected = false;

    await controller.stop();
    expect(state.record?.phase).toBe("stopping");
    expect(stopOnServer).not.toHaveBeenCalled();

    state.connected = true;
    expect(await controller.reconcile()).toBe(PHONE_STILL_LISTED);
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(state.record?.phase).toBe("listed");
    expect(deregister).not.toHaveBeenCalled();

    state.account = "user_a";
    expect(await controller.reconcile()).toBeNull();
    expect(deregister).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("stops a share it has no record of, and never deregisters under another account", async () => {
    const { state, controller, deregister, stopOnServer } = setup();
    state.sharing = shared("user_b");
    expect(await controller.stop()).toBe(PHONE_STILL_LISTED);
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(deregister).not.toHaveBeenCalled();
    expect(state.record).toEqual({ environmentId, accountId: "user_b", phase: "listed" });
  });

  it("rolls a failed share back without signing anyone out, and drops its record", async () => {
    const { state, controller, stopOnServer, deregister } = setup();
    state.deregisterFailure = "not linked";
    const failure = await controller.share(connection, "user_a", async () => "over the limit");
    expect(failure).toBe("over the limit");
    expect(stopOnServer).toHaveBeenCalledWith(connection, { revokeAccess: false });
    expect(deregister).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("treats a share a killed app never finished as failed", async () => {
    const { state, controller, stopOnServer } = setup(on);
    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).toHaveBeenCalledWith(connection, { revokeAccess: false });
    expect(state.record).toBeNull();
  });

  it("leaves a healthy share alone", async () => {
    const { state, controller, stopOnServer } = setup(on);
    state.sharing = shared("user_a");
    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).not.toHaveBeenCalled();
    expect(state.record).toEqual(on);
  });

  it("removes the listing when Ubuntu goes, even with the server down", async () => {
    const { state, controller, deregister } = setup(on);
    state.connected = false;
    expect(await controller.release()).toBeNull();
    expect(deregister).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("keeps the listing's record through a release while signed out", async () => {
    const { state, controller } = setup(on);
    state.connected = false;
    state.account = null;
    expect(await controller.release()).toBe(PHONE_STILL_LISTED);
    expect(state.record?.phase).toBe("listed");
  });

  it("won't let a connection be forgotten while its tunnel can't be stopped", async () => {
    const { state, controller } = setup(on);
    state.stopFailure = "unreachable";
    expect(await controller.stopBeforeForgetting()).toBe("unreachable");
    state.stopFailure = null;
    expect(await controller.stopBeforeForgetting()).toBeNull();
  });

  it("waits for saved preferences before deciding anything", async () => {
    const { state, stopOnServer } = setup();
    let hydrate = () => {};
    const hydrating = new Promise<void>((resolve) => {
      hydrate = resolve;
    });
    const controller = createPhoneSharingController({
      hydrated: () => hydrating,
      loadRecord: () => state.record,
      saveRecord: (record) => {
        state.record = record;
      },
      phoneEnvironmentId: () => environmentId,
      connectionFor: () => connection,
      signedInAccount: () => null,
      readSharing: async () => shared("user_a"),
      ensureRelayClient: async () => null,
      stopOnServer,
      deregister: async () => null,
    });
    const stopped = controller.stop();
    expect(stopOnServer).not.toHaveBeenCalled();
    state.record = on;
    hydrate();
    await stopped;
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(state.record?.accountId).toBe("user_a");
  });
});
