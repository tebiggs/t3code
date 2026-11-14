import {
  AuthSessionId,
  AuthStandardClientScopes,
  AuthViewOnlyClientScopes,
  EnvironmentId,
} from "@t3tools/contracts";
import { RELAY_MINT_REQUEST_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as EnvironmentKeys from "./environmentKeys.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  CLOUD_SHARING_MODE,
  CLOUD_SHARING_MODE_CHANGE_PENDING,
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
const callerSession = AuthSessionId.make("session-phone");

const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
let mintProofCount = 0;
const mintRequest = Effect.gen(function* () {
  mintProofCount += 1;
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const proof = yield* signRelayJwt({
    privateKey: mintKeys.privateKey,
    typ: RELAY_MINT_REQUEST_TYP,
    payload: {
      iss: "https://relay.test",
      aud: "t3-env:environment-1",
      sub: "user-1",
      jti: `jti-${mintProofCount}`,
      iat: now,
      exp: now + 60,
      environmentId: "environment-1",
      clientProofKeyThumbprint: "thumbprint",
      cnf: { jkt: "thumbprint" },
      nonce: `nonce-${mintProofCount}`,
      scope: ["environment:connect"],
    },
  });
  return { proof };
}).pipe(Effect.orDie, Effect.provide(NodePlatformCrypto.layerSignature));

const withService = <A, E>(
  options: {
    readonly failHoldWrite?: boolean;
    readonly failActivityWrite?: boolean;
    readonly relayFails?: boolean;
    readonly failActivityRead?: boolean;
    readonly failHoldRead?: boolean;
    readonly holdFirstRelayCall?: {
      readonly started: () => void;
      readonly released: Promise<void>;
    };
    readonly auth?: Partial<EnvironmentAuth.EnvironmentAuth["Service"]>;
    readonly initialSecrets?: ReadonlyArray<readonly [string, string]>;
    readonly failSecretRead?: string;
  },
  body: (input: {
    readonly preferences: { readonly update: CloudLink.CloudLink["Service"]["updatePreferences"] };
    readonly link: CloudLink.CloudLink["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly relayCalls: Array<boolean>;
    readonly connectCredentialRequests: Array<
      Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["issueConnectCredential"]>[0]
    >;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>([
      [RELAY_URL_SECRET, encode("https://relay.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential")],
      [HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, encode("false")],
      [PUBLISH_AGENT_ACTIVITY_SECRET, encode("false")],
      [CLOUD_MINT_PUBLIC_KEY, encode(mintKeys.publicKey)],
      [CLOUD_LINKED_USER_ID, encode("user-1")],
      ...(options.initialSecrets ?? []).map(
        ([name, value]) => [name, encode(value)] as [string, Uint8Array],
      ),
    ]);
    const relayCalls: Array<boolean> = [];
    const connectCredentialRequests: Array<
      Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["issueConnectCredential"]>[0]
    > = [];
    const fetch: typeof globalThis.fetch = Object.assign(
      (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { holdWebhooksWhileOffline: boolean };
        relayCalls.push(payload.holdWebhooksWhileOffline);
        if (relayCalls.length === 1 && options.holdFirstRelayCall) {
          options.holdFirstRelayCall.started();
          return options.holdFirstRelayCall.released.then(() => Response.json(payload));
        }
        return options.relayFails
          ? Promise.resolve(new Response("unavailable", { status: 503 }))
          : Promise.resolve(Response.json(payload));
      },
      { preconnect: () => {} },
    );
    const layerDependencies = Layer.mergeAll(
      ServerSettings.ServerSettingsService.layerTest(),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) =>
          (options.failActivityRead && name === PUBLISH_AGENT_ACTIVITY_SECRET) ||
          (options.failHoldRead && name === HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET) ||
          options.failSecretRead === name
            ? Effect.fail(
                new ServerSecretStore.SecretStoreReadError({
                  resource: name,
                  cause: new Error("busy"),
                }),
              )
            : Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) =>
          (options.failHoldWrite && name === HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET) ||
          (options.failActivityWrite && name === PUBLISH_AGENT_ACTIVITY_SECRET)
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: new Error("read-only"),
                }),
              )
            : Effect.sync(() => void stored.set(name, value)),
        create: (name, value) => Effect.sync(() => void stored.set(name, value)),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ requestCatchUp: () => Effect.void }),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
      ManagedPolicy.layerTest(),
      Layer.mock(ConnectReachability.ConnectReachability)({
        latest: Effect.succeedNone,
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        isSessionActive: () => Effect.succeed(true),
        issueConnectCredential: (input) =>
          Effect.sync(() => {
            connectCredentialRequests.push(input);
            return { credential: "pairing-credential", expiresAt: DateTime.makeUnsafe(120_000) };
          }),
        ...options.auth,
      }),
      Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
      NodeServices.layer,
      NodePlatformCrypto.layer,
    );
    return yield* Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      return yield* body({
        preferences: { update: link.updatePreferences },
        link,
        stored,
        relayCalls,
        connectCredentialRequests,
      });
    }).pipe(
      Effect.provide(
        CloudLink.layer.pipe(
          // The mocked secret store can't create a key pair, and no test checks a signature.
          Layer.provide(
            Layer.mock(EnvironmentKeys.EnvironmentSigningKey)({
              publicKey: "",
              sign: () => Effect.succeed("signed"),
            }),
          ),
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

it.effect("tells the relay before saving the hold setting locally", () =>
  withService({}, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      yield* preferences.update({ publishAgentActivity: true, holdWebhooksWhileOffline: true });
      assert.deepEqual(relayCalls, [true]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "true",
      );
    }),
  ),
);

it.effect("puts the relay back when the local save fails", () =>
  withService({ failHoldWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "CloudLinkInternalError",
        operation: "persist-preferences",
      });
      assert.deepEqual(relayCalls, [true, false]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("leaves the relay untouched when the activity setting can't be saved", () =>
  withService({ failActivityWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "CloudLinkInternalError",
        operation: "persist-preferences",
      });
      assert.deepEqual(relayCalls, []);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("keeps both settings unchanged when the relay refuses the hold change", () =>
  withService({ relayFails: true }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("two overlapping updates are applied one after the other", () => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstAtRelay = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService({ holdFirstRelayCall: { started, released } }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      const first = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => firstAtRelay);
      const second = yield* preferences
        .update({ publishAgentActivity: false, holdWebhooksWhileOffline: false })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "true");
      release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  );
});

it.effect("an update the client walks away from still finishes", () => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atRelay = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService({ holdFirstRelayCall: { started, released } }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      const update = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => atRelay);
      const interrupted = yield* Fiber.interrupt(update).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      release();
      yield* Fiber.join(interrupted);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "true");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "true",
      );
    }),
  );
});

it.effect.each([
  { name: "no stored mode", initial: [], scopes: AuthStandardClientScopes },
  {
    name: "Full control",
    initial: [[CLOUD_SHARING_MODE, "full-control"]] as const,
    scopes: AuthStandardClientScopes,
  },
  {
    name: "View only",
    initial: [[CLOUD_SHARING_MODE, "view-only"]] as const,
    scopes: AuthViewOnlyClientScopes,
  },
  {
    name: "a mode this version doesn't know",
    initial: [[CLOUD_SHARING_MODE, "guest"]] as const,
    scopes: AuthViewOnlyClientScopes,
  },
])("a device minting under $name gets the matching scopes", ({ initial, scopes }) =>
  withService({ initialSecrets: initial }, ({ link, connectCredentialRequests }) =>
    Effect.gen(function* () {
      yield* link.mintCredential(yield* mintRequest);
      assert.deepEqual(connectCredentialRequests, [
        { proofKeyThumbprint: "thumbprint", requireApproval: false, scopes },
      ]);
    }),
  ),
);

it.effect("an unreadable mode refuses the mint instead of granting full access", () =>
  withService({ failSecretRead: CLOUD_SHARING_MODE }, ({ link, connectCredentialRequests }) =>
    Effect.gen(function* () {
      const failure = yield* link.mintCredential(yield* mintRequest).pipe(Effect.flip);
      assert.equal(failure._tag, "CloudLinkInternalError");
      assert.deepEqual(connectCredentialRequests, []);
    }),
  ),
);

it.effect("a mode change stores the mode before signing anyone out", () => {
  const seenAtRevoke: Array<string> = [];
  let stored: Map<string, Uint8Array> | undefined;
  return withService(
    {
      auth: {
        revokeOtherAccess: (sessionId) =>
          Effect.sync(() => {
            seenAtRevoke.push(sessionId, decode(stored?.get(CLOUD_SHARING_MODE)));
          }),
      },
    },
    ({ link, stored: secrets }) =>
      Effect.gen(function* () {
        stored = secrets;
        const state = yield* link.setSharingMode("view-only", callerSession);
        assert.deepEqual(seenAtRevoke, [callerSession, "view-only"]);
        assert.equal(state.sharingMode, "view-only");
        assert.equal(state.sharingModeChangePending, false);
        assert.isFalse(secrets.has(CLOUD_SHARING_MODE_CHANGE_PENDING));
      }),
  );
});

it.effect("a caller signed out while its change waited can't undo the mode", () => {
  const revoked: Array<string> = [];
  return withService(
    {
      initialSecrets: [[CLOUD_SHARING_MODE, "view-only"]],
      auth: {
        isSessionActive: () => Effect.succeed(false),
        revokeOtherAccess: (sessionId) => Effect.sync(() => void revoked.push(sessionId)),
      },
    },
    ({ link, stored }) =>
      Effect.gen(function* () {
        const failure = yield* link.setSharingMode("full-control", callerSession).pipe(Effect.flip);
        assert.equal(failure._tag, "CloudLinkInternalError");
        assert.equal(decode(stored.get(CLOUD_SHARING_MODE)), "view-only");
        assert.deepEqual(revoked, []);
      }),
  );
});

it.effect("a failed sign-out keeps the new mode and says the change isn't finished", () => {
  let failing = true;
  return withService(
    {
      auth: {
        revokeOtherAccess: () =>
          failing
            ? Effect.fail(
                new EnvironmentAuth.ServerAuthOtherSessionsRevocationError({
                  cause: new Error("locked"),
                }),
              )
            : Effect.void,
      },
    },
    ({ link, stored }) =>
      Effect.gen(function* () {
        const failure = yield* link.setSharingMode("view-only", callerSession).pipe(Effect.flip);
        assert.equal(failure._tag, "CloudLinkInternalError");
        assert.equal(decode(stored.get(CLOUD_SHARING_MODE)), "view-only");
        const pending = yield* link.linkState();
        assert.equal(pending.sharingMode, "view-only");
        assert.equal(pending.sharingModeChangePending, true);

        failing = false;
        const retried = yield* link.setSharingMode("view-only", callerSession);
        assert.equal(retried.sharingModeChangePending, false);
      }),
  );
});

it.effect("a change the client walks away from still signs the others out", () => {
  let release!: () => void;
  let started!: () => void;
  let revoked = false;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atRevoke = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService(
    {
      auth: {
        revokeOtherAccess: () =>
          Effect.promise(() => {
            started();
            return released;
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                revoked = true;
              }),
            ),
          ),
      },
    },
    ({ link, stored }) =>
      Effect.gen(function* () {
        const change = yield* link
          .setSharingMode("view-only", callerSession)
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => atRevoke);
        const interrupted = yield* Fiber.interrupt(change).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        release();
        yield* Fiber.join(interrupted);
        assert.isTrue(revoked);
        assert.isFalse(stored.has(CLOUD_SHARING_MODE_CHANGE_PENDING));
      }),
  );
});

it.effect("a mint in progress finishes before a mode change can sign anyone out", () => {
  const events: Array<string> = [];
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atMint = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService(
    {
      auth: {
        issueConnectCredential: (input) =>
          Effect.promise(() => {
            started();
            return released;
          }).pipe(
            Effect.map(() => {
              events.push(`minted:${String(input.scopes?.length)}`);
              return { credential: "credential", expiresAt: DateTime.makeUnsafe(120_000) };
            }),
          ),
        revokeOtherAccess: () => Effect.sync(() => void events.push("revoked")),
      },
    },
    ({ link }) =>
      Effect.gen(function* () {
        const mint = yield* link.mintCredential(yield* mintRequest).pipe(Effect.forkChild);
        yield* Effect.promise(() => atMint);
        const change = yield* link
          .setSharingMode("view-only", callerSession)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.deepEqual(events, []);
        release();
        yield* Fiber.join(mint);
        yield* Fiber.join(change);
        assert.deepEqual(events, [`minted:${AuthStandardClientScopes.length}`, "revoked"]);
      }),
  );
});

it.effect("a mint during a mode change waits and gets the new scopes", () => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atRevoke = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService(
    {
      auth: {
        revokeOtherAccess: () =>
          Effect.promise(() => {
            started();
            return released;
          }),
      },
    },
    ({ link, connectCredentialRequests }) =>
      Effect.gen(function* () {
        const request = yield* mintRequest;
        const change = yield* link
          .setSharingMode("view-only", callerSession)
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => atRevoke);
        const mint = yield* link.mintCredential(request).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.deepEqual(connectCredentialRequests, []);
        release();
        yield* Fiber.join(change);
        yield* Fiber.join(mint);
        assert.deepEqual(
          connectCredentialRequests.map((request) => request.scopes),
          [AuthViewOnlyClientScopes],
        );
      }),
  );
});

it.effect("unlinks on startup and refuses to link when the policy turns Connect off", () =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>([
      [CLOUD_LINKED_USER_ID, encode("user-1")],
      [RELAY_URL_SECRET, encode("https://relay.test")],
    ]);
    const appliedConfigs: Array<unknown> = [];
    const layerDependencies = Layer.mergeAll(
      ServerSettings.ServerSettingsService.layerTest(),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({}),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
        withLinkStateLock: (effect) => effect,
        applyConfig: (config) =>
          Effect.sync(() => {
            appliedConfigs.push(config);
            return { status: "disabled" as const };
          }),
      }),
      ManagedPolicy.layerTest({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { connect: false },
      }),
      Layer.mock(ConnectReachability.ConnectReachability)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
      NodeServices.layer,
      NodePlatformCrypto.layer,
    );
    yield* Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      assert.isFalse(stored.has(CLOUD_LINKED_USER_ID));
      assert.deepEqual(appliedConfigs, [null]);

      const applyError = yield* link.applyRelayConfig({} as never).pipe(Effect.flip);
      const mintError = yield* link.mintCredential({} as never).pipe(Effect.flip);
      const modeError = yield* link.setSharingMode("view-only", callerSession).pipe(Effect.flip);
      assert.equal(applyError.message, "Example Corp's policy does not allow T3 Connect.");
      assert.equal(mintError._tag, "ManagedPolicyRefusedError");
      assert.equal(modeError._tag, "ManagedPolicyRefusedError");
    }).pipe(
      Effect.provide(
        CloudLink.layer.pipe(
          // These tests never sign proofs; the mocked secret store cannot create a key pair.
          Layer.provide(Layer.mock(EnvironmentKeys.EnvironmentSigningKey)({ publicKey: "" })),
          Layer.provide(layerDependencies),
        ),
      ),
    );
  }),
);
