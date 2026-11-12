import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as RelayConfiguration from "../../../../../infra/relay/src/Config.ts";
import * as WebCrypto from "../../../../../infra/relay/src/WebCrypto.ts";
import * as FcmAssertionSigner from "../../../../../infra/relay/src/agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "../../../../../infra/relay/src/agentActivity/FcmClient.ts";

/** The Firebase service account that makes this server the push host. */
const SERVICE_ACCOUNT_FILE_ENV = "T3CODE_FCM_SERVICE_ACCOUNT_FILE";
/** Development only: FCM checks each message and the key but delivers nothing. */
const VALIDATE_ONLY_ENV = "T3CODE_FCM_VALIDATE_ONLY";

export type FcmSend = FcmClient.FcmClient["Service"]["send"];
export { FcmClientError } from "../../../../../infra/relay/src/agentActivity/FcmClient.ts";

/** How this server sends to FCM; `send` is null when it holds no key and is not the push host. */
export class PushHostFcm extends Context.Service<
  PushHostFcm,
  { readonly send: FcmSend | null; readonly projectId: string | null }
>()("t3/fork/push/fcm/PushHostFcm") {}

const decodeProjectId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ project_id: Schema.NonEmptyString })),
);

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const isFcmSend = (request: HttpClientRequest.HttpClientRequest) =>
  request.method === "POST" && request.url.startsWith("https://fcm.googleapis.com/");

/** Adds FCM's `validate_only` to every send, so a check never reaches a phone. */
const validateOnly = (request: HttpClientRequest.HttpClientRequest) => {
  if (!isFcmSend(request) || request.body._tag !== "Uint8Array") return request;
  const message = decodeMessage(new TextDecoder().decode(request.body.body));
  if (Option.isNone(message)) return request;
  return HttpClientRequest.setBody(
    request,
    HttpBody.jsonUnsafe({ ...message.value, validate_only: true }),
  );
};

const relayConfiguration = (
  serviceAccount: string,
): RelayConfiguration.RelayConfiguration["Service"] => ({
  // FcmClient reads only the service account; the rest is the relay's own deployment.
  relayIssuer: "",
  apns: null,
  fcmServiceAccount: Redacted.make(serviceAccount),
  clerkSecretKey: Redacted.make(""),
  clerkPublishableKey: "",
  clerkJwtAudience: "",
  apnsDeliveryJobSigningSecret: Redacted.make(""),
  cloudMintPrivateKey: Redacted.make(""),
  cloudMintPublicKey: "",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const unconfigured = PushHostFcm.of({ send: null, projectId: null });

export const layer = Layer.effect(
  PushHostFcm,
  Effect.gen(function* () {
    const path = yield* Config.String(SERVICE_ACCOUNT_FILE_ENV).pipe(Config.option);
    if (Option.isNone(path) || path.value.trim() === "") return unconfigured;
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(path.value.trim()).pipe(Effect.option);
    if (Option.isNone(contents)) {
      yield* Effect.logError("Push host is off: the FCM service account file could not be read", {
        path: path.value,
      });
      return unconfigured;
    }
    const projectId = decodeProjectId(contents.value);
    if (Option.isNone(projectId)) {
      yield* Effect.logError("Push host is off: the FCM service account file is not a key", {
        path: path.value,
      });
      return unconfigured;
    }
    const checkOnly = yield* Config.Boolean(VALIDATE_ONLY_ENV).pipe(Config.withDefault(false));
    const httpClient = yield* HttpClient.HttpClient;
    const client = yield* FcmClient.FcmClient.pipe(
      Effect.provide(
        FcmClient.layer.pipe(
          Layer.provide(
            FcmAssertionSigner.layer.pipe(
              Layer.provide(
                Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
              ),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              RelayConfiguration.RelayConfiguration,
              relayConfiguration(contents.value),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              checkOnly ? HttpClient.mapRequest(httpClient, validateOnly) : httpClient,
            ),
          ),
        ),
      ),
    );
    yield* Effect.logInfo("Push host is on", {
      projectId: projectId.value.project_id,
      validateOnly: checkOnly,
    });
    return PushHostFcm.of({ send: client.send, projectId: projectId.value.project_id });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
