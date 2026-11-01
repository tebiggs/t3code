import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import {
  cliReleaseIndexPageUrl,
  cliReleaseTagApiUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optional(Schema.Boolean),
});
const decodeRelease = Schema.decodeUnknownOption(Schema.fromJsonString(Release));
const decodeReleaseIndex = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Release)));
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

/** Null when the track has no release yet. */
function toVersion(spec: string, track: "stable" | "nightly" | null, json: string) {
  const invalid = new ServerNpmReleaseError({
    reason: "GitHub returned invalid release metadata.",
  });
  if (track === null) {
    const release = Option.getOrUndefined(decodeRelease(json));
    return release?.tag_name === `v${spec}` ? Effect.succeed(spec) : Effect.fail(invalid);
  }
  const releases = Option.getOrUndefined(decodeReleaseIndex(json));
  return releases === undefined
    ? Effect.fail(invalid)
    : Effect.succeed(newestCliReleaseVersion(releases, track) ?? null);
}

/** Fork (FORK.md): reads this fork's GitHub releases, which npm never has. They carry no manifest,
 * so `databaseMigration` stays absent and a track crossing stays blocked. */
export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      const track = spec === "latest" ? "stable" : spec === "nightly" ? "nightly" : null;
      const unreachable = new ServerNpmReleaseError({
        reason: "GitHub releases could not be reached.",
      });
      const json = yield* Effect.gen(function* () {
        const response = yield* http.get(
          track === null ? cliReleaseTagApiUrl(spec) : cliReleaseIndexPageUrl(1),
        );
        if (response.status === 404) return Option.none<string>();
        if (response.status < 200 || response.status >= 300) return yield* unreachable;
        return Option.some(yield* response.text);
      }).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.mapError(() => unreachable),
      );
      if (Option.isNone(json)) return null;
      const version = yield* toVersion(spec, track, json.value);
      return version === null ? null : { version };
    }),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
