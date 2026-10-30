import { Atom, AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { npmReleaseAtom, npmReleasePublishedAtom } from "./npmRelease";

const version = "0.0.46-nightly.20261012.3021";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settled<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("npmReleasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("checks the fork's GitHub release without tracing headers, so the browser skips a preflight", async () => {
    fetchMock.mockImplementation(async () => Response.json({ tag_name: `v${version}` }));

    const result = await settled(npmReleasePublishedAtom(version));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      `https://api.github.com/repos/tebiggs/t3code/releases/tags/v${version}`,
    );
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  it("resolves a dist-tag from the fork's releases, which report no database migration", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json([{ tag_name: "v0.1.6-preview.20261030.9" }, { tag_name: `v${version}` }]),
    );

    const nightly = await settled(npmReleaseAtom("nightly"));
    const stable = await settled(npmReleaseAtom("latest"));

    expect(new Request(fetchMock.mock.calls[0]?.[0] ?? "").url).toBe(
      "https://api.github.com/repos/tebiggs/t3code/releases?per_page=100&page=1",
    );
    expect(AsyncResult.getOrElse(nightly, () => null)).toEqual({
      version,
      databaseMigration: undefined,
    });
    expect(AsyncResult.getOrElse(stable, () => "pending")).toBeNull();
  });

  // regression: #18709 update-everything skipped npm-installed servers
  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settled(npmReleasePublishedAtom(version));

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });
});
