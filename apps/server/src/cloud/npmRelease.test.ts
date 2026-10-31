import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as NpmRelease from "./npmRelease.ts";

const version = "0.1.5-nightly.20261030.1";
const releasesUrl = "https://api.github.com/repos/tebiggs/t3code/releases";

const makeService = (respond: (url: string) => Response) => {
  const urls: string[] = [];
  return NpmRelease.make().pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url)));
      }),
    ),
    Effect.map((service) => ({ service, urls })),
  );
};

it.effect("resolves a track from the fork's releases and caches it for a minute", () =>
  Effect.gen(function* () {
    const { service, urls } = yield* makeService(() =>
      Response.json([
        { tag_name: "v0.1.6-preview.20261030.9" },
        { tag_name: "v0.1.6-nightly.20261031.2", draft: true },
        { tag_name: `v${version}` },
      ]),
    );
    const expected = { version };
    expect(yield* service.get({ spec: "nightly" })).toEqual(expected);
    expect(yield* service.get({ spec: "nightly" })).toEqual(expected);
    expect(urls).toEqual([`${releasesUrl}?per_page=100&page=1`]);
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: "nightly" })).toEqual(expected);
    expect(urls).toHaveLength(2);
    expect(yield* service.get({ spec: "latest" })).toBeNull();
  }),
);

it.effect("looks up an exact version by its tag and treats a 404 as unpublished", () =>
  Effect.gen(function* () {
    const { service, urls } = yield* makeService((url) =>
      url.endsWith(`/tags/v${version}`)
        ? Response.json({ tag_name: `v${version}` })
        : new Response("{}", { status: 404 }),
    );
    expect(yield* service.get({ spec: version })).toEqual({ version });
    expect(yield* service.get({ spec: "9.9.9" })).toBeNull();
    expect(urls).toEqual([`${releasesUrl}/tags/v${version}`, `${releasesUrl}/tags/v9.9.9`]);
  }),
);

it.effect.each([
  { spec: "nightly", response: () => new Response("rate limited", { status: 403 }) },
  { spec: "nightly", response: () => new Response("not json") },
  { spec: "nightly", response: () => Response.json({ message: "not a list" }) },
  { spec: version, response: () => Response.json({ tag_name: "v9.9.9" }) },
])("reports an unavailable lookup rather than an unpublished release: $spec", (fixture) =>
  Effect.gen(function* () {
    const { service } = yield* makeService(fixture.response);
    const found = yield* service.get({ spec: fixture.spec }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
  }),
);

it.effect("gives up on a stalled lookup after 15 seconds", () =>
  Effect.gen(function* () {
    const { service } = yield* makeService(() => new Response(new ReadableStream()));
    const stalled = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(stalled))).toBe(true);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before any request: %s",
  (spec) =>
    Effect.gen(function* () {
      const { service, urls } = yield* makeService(() => new Response("{}"));
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
      expect(urls).toEqual([]);
    }),
);
