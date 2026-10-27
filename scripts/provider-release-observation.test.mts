import { test } from "node:test";
import assert from "node:assert/strict";
import {
  observeProviderSource,
  validateProviderProgress,
} from "./provider-release-observation.mts";
import type {
  ProviderSource,
  ProviderProgress,
  ProviderCapacity,
} from "./provider-release-observation.mts";
import { observationHash } from "./upstream-observer.mts";
function fixture(pages = 9) {
  const source: ProviderSource = {
    key: "b".repeat(64),
    provider: "gitlab",
    repository: "owner/project",
    scope_sha256: "a".repeat(64),
    ports: [{ id: "example", release: { repository: "owner/project" } }],
  };
  let prior: ProviderProgress | undefined,
    now = Date.parse("2026-10-27T00:00:00Z"),
    changed = false,
    quota: number | null = null;
  const calls: string[] = [],
    capacities: Record<string, ProviderCapacity> = {};
  const options = {
    now: () => now,
    deadline: now + 180000,
    maximumRequests: 4,
    maximumBytes: 16 * 1024 * 1024,
    capacities,
    admit: () => {},
    charge: () => {},
    commit: async (value: ProviderProgress) => {
      prior = structuredClone(value);
    },
    project: async (_port: string, observation: Record<string, unknown>) => ({
      facts_sha256: observation.facts_sha256,
    }),
    fetch: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url.href);
      if (new Headers(init?.headers).has("If-None-Match") && !changed)
        return new Response(null, { status: 304 });
      let body: unknown;
      const page = Number(url.searchParams.get("page") ?? 1);
      if (url.pathname.endsWith("releases"))
        body = [
          {
            tag_name: `v${changed ? 999 + page : page}`,
            upcoming_release: false,
            released_at: "2026-10-26T00:00:00Z",
            assets: { links: [] },
          },
        ];
      else if (url.pathname.endsWith("packages"))
        body = [{ id: 101, version: "v1", name: "example" }];
      else if (url.pathname.endsWith("package_files"))
        body = [{ id: 301, file_name: "example.zip", size: 100, file_sha256: "a".repeat(64) }];
      else body = { id: 7, path_with_namespace: source.repository, archived: false };
      return new Response(JSON.stringify(body), {
        headers: {
          etag: '"stable"',
          "x-next-page": url.pathname.endsWith("releases") && page < pages ? String(page + 1) : "",
          ...(quota === null
            ? {}
            : {
                "ratelimit-remaining": String(quota),
                "ratelimit-limit": "100",
                "ratelimit-reset": String(Math.floor((now + 60000) / 1000)),
              }),
        },
      });
    }) as typeof fetch,
  };
  return {
    source,
    options,
    calls,
    prior: () => prior,
    change: () => {
      changed = true;
    },
    quota: (n: number | null) => {
      quota = n;
    },
    tick: () => {
      now += 61000;
      options.deadline = now + 180000;
    },
  };
}
void test("GitLab collection and conditional verification continue beyond six pages through bounded prefixes", async () => {
  const h = fixture();
  let result;
  for (let run = 0; run < 20; run++) {
    const before = h.calls.length;
    try {
      result = await observeProviderSource(h.source, h.prior(), h.options);
      break;
    } catch (error) {
      assert.equal((error as { rule: string }).rule, "budget");
    }
    assert.ok(h.calls.length - before <= 4);
  }
  assert.ok(result);
  assert.equal(
    result.observations[0]!.facts_sha256,
    observationHash(result.observations[0]!.facts),
  );
  const releaseCalls = h.calls.filter((s) => new URL(s).pathname.endsWith("releases"));
  for (let page = 1; page <= 9; page++)
    assert.equal(
      releaseCalls.filter((s) => new URL(s).searchParams.get("page") === String(page)).length,
      2,
    );
  assert.equal(h.prior()!.validation_cursor, h.prior()!.reads.length);
});
void test("changed inputs, corrupt proofs and changed provider facts refuse partial publication", async () => {
  const h = fixture();
  await assert.rejects(observeProviderSource(h.source, undefined, h.options));
  const before = h.calls.length;
  await assert.rejects(
    observeProviderSource({ ...h.source, scope_sha256: "c".repeat(64) }, h.prior(), h.options),
    /scope changed/u,
  );
  assert.equal(h.calls.length, before);
  const corrupt = structuredClone(h.prior()!);
  corrupt.reads[0]!.sha256 = "0".repeat(64);
  assert.throws(() => validateProviderProgress(corrupt), /Corrupt/u);
  h.change();
  let changed = false;
  for (let i = 0; i < 20; i++) {
    try {
      await observeProviderSource(h.source, h.prior(), h.options);
      assert.fail("changed facts published");
    } catch (error) {
      if ((error as { rule: string }).rule === "provider-changed") {
        changed = true;
        break;
      }
      assert.equal((error as { rule: string }).rule, "budget");
    }
  }
  assert.ok(changed);
  assert.equal(h.prior()!.reads.length, 0);
});
void test("provider reserve survives continuation and resets without fabricating available capacity", async () => {
  const h = fixture(1);
  h.quota(5);
  await assert.rejects(
    observeProviderSource(h.source, undefined, h.options),
    (error: { rule: string }) => error.rule === "provider-quota",
  );
  const count = h.calls.length;
  await assert.rejects(observeProviderSource(h.source, h.prior(), h.options));
  assert.equal(h.calls.length, count);
  h.tick();
  h.quota(null);
  const result = await observeProviderSource(h.source, h.prior(), {
    ...h.options,
    maximumRequests: 20,
  });
  assert.ok(result.observations.length);
  assert.equal(h.options.capacities["https://gitlab.com"]!.remaining, null);
});
void test("cancellation preserves the accepted prefix and never calls Core", async () => {
  const h = fixture(1),
    controller = new AbortController();
  const options = {
    ...h.options,
    signal: controller.signal,
    commit: async (state: ProviderProgress) => {
      await h.options.commit(state);
      controller.abort();
    },
    project: async () => assert.fail("cancelled Core projection"),
  };
  await assert.rejects(
    observeProviderSource(h.source, undefined, options),
    (error: { rule: string }) => error.rule === "cancelled",
  );
  assert.equal(h.prior()!.reads.length, 1);
  assert.equal(h.calls.length, 1);
});
void test("fixed manifest endpoints use bounded HEAD redirects without credentials or executable trust", async () => {
  const h = fixture();
  const source: ProviderSource = {
    ...h.source,
    provider: "direct-manifest",
    ports: [
      { id: "example", release: { direct: { windows: { url: "https://example.org/pin.zip" } } } },
    ],
  };
  let calls = 0;
  const result = await observeProviderSource(source, undefined, {
    ...h.options,
    fetch: async (_input, init) => {
      calls++;
      assert.equal(init?.method, "HEAD");
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example.org/pin.zip" },
          })
        : new Response(null, { headers: { "content-length": "123" } });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.observations[0]!.facts, {
    endpoints: {
      "https://example.org/pin.zip": {
        url: "https://example.org/pin.zip",
        status: 200,
        content_length: 123,
      },
    },
  });
});

void test("a failed final admitted read stays a transport failure rather than automatic budget continuation", async () => {
  const h = fixture(2);
  let count = 0;
  const fetcher = h.options.fetch;
  await assert.rejects(
    observeProviderSource(h.source, undefined, {
      ...h.options,
      maximumRequests: 2,
      fetch: async (...args) => {
        if (++count === 2) throw new Error("original provider socket failure");
        return fetcher(...args);
      },
    }),
    (error: { rule: string }) => error.rule === "provider-transport",
  );
  assert.equal(count, 2);
  assert.equal(h.prior()!.reads.length, 1);
});
void test("numeric GitLab project identity binds before release collection and rejects replacement", async () => {
  const h = fixture(1);
  let identity: number | null = null;
  const bindIdentity = async (id: number) => {
    if (identity !== null && id !== identity) throw new Error("project identity changed");
    identity = id;
  };
  const result = await observeProviderSource(h.source, undefined, {
    ...h.options,
    maximumRequests: 20,
    bindIdentity,
  });
  assert.equal(identity, 7);
  const before = h.calls.length;
  await assert.rejects(
    observeProviderSource(h.source, result.state, {
      ...h.options,
      bindIdentity: async () => {
        throw new Error("project identity changed");
      },
    }),
    /identity changed/u,
  );
  assert.equal(h.calls.length, before);
});

for (const malformed of ["project", "list", "file"] as const) {
  void test(`a malformed ${malformed} response is never accepted and a corrected provider resumes automatically`, async () => {
    const h = fixture(1);
    let broken = true;
    const fetcher = h.options.fetch;
    const options = {
      ...h.options,
      maximumRequests: 20,
      fetch: (async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const matching =
          malformed === "project"
            ? !url.search && !url.pathname.endsWith("package_files")
            : malformed === "list"
              ? url.pathname.endsWith("releases")
              : url.pathname.endsWith("package_files");
        if (broken && matching)
          return new Response(
            JSON.stringify(
              malformed === "project"
                ? { id: 7, path_with_namespace: "foreign/project", archived: false }
                : malformed === "list"
                  ? {}
                  : [{ id: 301, file_name: "bad.zip", size: 100, file_sha256: "invalid" }],
            ),
          );
        return fetcher(input, init);
      }) as typeof fetch,
    };
    await assert.rejects(observeProviderSource(h.source, undefined, options));
    const accepted = h.prior()?.reads.length ?? 0;
    assert.equal(accepted, malformed === "project" ? 0 : malformed === "list" ? 1 : 3);
    broken = false;
    const result = await observeProviderSource(h.source, h.prior(), options);
    assert.equal(result.observations.length, 1);
    assert.equal(result.state.reads.length, 4);
  });
}
