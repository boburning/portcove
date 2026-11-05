import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  createPagesProviderTransport,
  createPagesProviderOperations,
  isTerminalPagesFailure,
} from "./release-pages-provider.mts";
import type { PagesProviderOperations } from "./release-pages-provider.mts";

const expected = {
  artifact_id: 12,
  controller_revision: "a".repeat(40),
  generation: "b".repeat(64),
};
const ack = {
  id: expected.generation,
  status_url:
    "https://api.github.com/repos/boburning/portcove/pages/deployments/" + expected.generation,
  page_url: "https://boburning.github.io/portcove/",
};
const response = (body: unknown, status = 200) => ({ status, body });
function operations(partial: Partial<PagesProviderOperations>): PagesProviderOperations {
  return {
    async create() {
      throw Error("unexpected Pages creation");
    },
    async observe() {
      throw Error("unexpected Pages observation");
    },
    ...partial,
  };
}

void test("one phase deadline covers credential delay, pre-POST guard and ambiguous late acknowledgement", async () => {
  let posts = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = createPagesProviderTransport(
    {
      token: async () => {
        await blocked;
        return "inert-token";
      },
      operations: operations({
        async create() {
          posts++;
          return response(ack);
        },
      }),
    },
    performance.now() + 100,
  );
  const attempt = provider.create(expected);
  await new Promise((resolve) => setTimeout(resolve, 110));
  release();
  await assert.rejects(attempt, /phase deadline/);
  assert.equal(posts, 0);
  await assert.rejects(provider.create(expected), /already attempted/);
  await assert.rejects(provider.observe({ ...expected, id: ack.id }), /phase deadline/);
  assert.throws(() => createPagesProviderTransport({}, Number.NaN), /phase deadline/);
  const late = createPagesProviderTransport(
    {
      token: async () => "inert-token",
      operations: operations({
        async create() {
          posts++;
          await new Promise((resolve) => setTimeout(resolve, 110));
          return response(ack);
        },
      }),
    },
    performance.now() + 100,
  );
  await assert.rejects(late.create(expected), /phase deadline/);
  assert.equal(posts, 1);
  await assert.rejects(late.create(expected), /already attempted/);
});

void test("documented Pages acknowledgement URLs remain fixed and recognized terminal statuses retain refusal", async () => {
  const provider = createPagesProviderTransport({
    token: async () => "inert-token",
    operations: operations({
      async create() {
        return response({
          ...ack,
          status_url: `${ack.status_url}/status`,
          page_url: "boburning.github.io/portcove/",
        });
      },
    }),
  });
  assert.equal((await provider.create(expected)).id, ack.id);
  for (const status of [
    "deployment_perms_error",
    "deployment_content_failed",
    "deployment_cancelled",
    "deployment_lost",
  ])
    assert.equal(isTerminalPagesFailure(status), true);
  assert.equal(isTerminalPagesFailure("succeed"), false);
});
void test("Pages acknowledgement must echo the exact unique generation build version", async () => {
  const provider = createPagesProviderTransport({
    token: async () => "inert-token",
    operations: operations({
      async create() {
        return response({ ...ack, id: "a".repeat(40) });
      },
    }),
  });
  await assert.rejects(provider.create(expected), /acknowledgement unavailable/);
  await assert.rejects(provider.create(expected), /already attempted/);
});
void test("controls expiring during token acquisition refuse before the POST and cannot repeat", async () => {
  let clock = 0,
    posts = 0;
  const provider = createPagesProviderTransport({
    token: async () => {
      clock = 60001;
      return "inert-token";
    },
    operations: operations({
      async create() {
        posts++;
        return response(ack);
      },
    }),
  });
  await assert.rejects(
    provider.create(expected, () => {
      if (clock >= 60000) throw Error("controls expired");
    }),
    /controls expired/,
  );
  assert.equal(posts, 0);
  await assert.rejects(provider.create(expected), /already attempted/);
});
void test("concurrent entry claims the one-shot boundary before asynchronous credential acquisition", async () => {
  let release!: (value: string) => void;
  const token = new Promise<string>((resolve) => {
    release = resolve;
  });
  let tokenCalls = 0,
    posts = 0;
  const provider = createPagesProviderTransport({
    token: () => {
      tokenCalls++;
      return token;
    },
    operations: operations({
      async create() {
        posts++;
        return response(ack);
      },
    }),
  });
  const first = provider.create(expected);
  const refused = assert.rejects(provider.create(expected), /already attempted/u);
  assert.equal(tokenCalls, 1);
  assert.equal(posts, 0);
  release("inert-token");
  await Promise.all([first, refused]);
  assert.equal(posts, 1);
});
void test("fixed Pages creation carries only opaque artifact/source and ephemeral audience token; acknowledgement is not acceptance", async () => {
  const calls: unknown[] = [];
  const provider = createPagesProviderTransport({
    token: async () => "inert-token",
    operations: operations({
      async create(body) {
        calls.push(body);
        return response(ack);
      },
    }),
  });
  const receipt = await provider.create(expected);
  assert.deepEqual(calls, [
    { artifact_id: 12, pages_build_version: expected.generation, oidc_token: "inert-token" },
  ]);
  assert.equal(receipt.evidence_scope, "injected-provider");
  assert.equal(receipt.acceptance, "pending-public-readback");
  assert.ok(!JSON.stringify(receipt).includes("inert-token"));
  await assert.rejects(provider.create(expected), /already attempted/u);
  assert.equal(calls.length, 1);
});
void test("lost/refused/contradictory POST retains ambiguity and cannot retry or leak token", async () => {
  for (const outcome of ["lost", "refused", "foreign", "missing"] as const) {
    let calls = 0;
    const provider = createPagesProviderTransport({
      token: async () => "inert-sensitive",
      operations: operations({
        async create() {
          calls++;
          if (outcome === "lost") throw new Error("inert-sensitive");
          if (outcome === "refused") return response({ message: "inert-sensitive" }, 403);
          return response(
            outcome === "foreign" ? { ...ack, page_url: "https://foreign.invalid/" } : {},
          );
        },
      }),
    });
    await assert.rejects(
      provider.create(expected),
      (error: Error) =>
        /preserve pending intent/u.test(error.message) &&
        !error.message.includes("inert-sensitive"),
    );
    await assert.rejects(provider.create(expected), /already attempted/u);
    assert.equal(calls, 1);
  }
});
void test("malformed request refuses before credential acquisition or provider effect", async () => {
  const provider = createPagesProviderTransport({
    token: async () => {
      throw Error("must not acquire");
    },
    operations: operations({}),
  });
  for (const bad of [
    { artifact_id: -1 },
    { controller_revision: "main" },
    { generation: "unknown" },
    { extra: true },
  ])
    await assert.rejects(provider.create({ ...expected, ...bad }), /identity is unavailable/u);
});
void test("status observation never establishes public bytes or deployment actor", async () => {
  const calls: string[] = [];
  const provider = createPagesProviderTransport({
    operations: operations({
      async observe(id) {
        calls.push(id);
        return response({ status: "succeed" });
      },
    }),
  });
  const observed = await provider.observeByGeneration(expected);
  assert.equal(observed.stage, "provider-status-only");
  assert.equal(observed.acceptance, "pending-public-readback");
  assert.deepEqual(calls, [expected.generation]);
  await assert.rejects(
    provider.observe({ ...expected, id: "../other" }),
    /identity is unavailable/u,
  );
  assert.equal(calls.length, 1);
});

const sdkOptions = () => ({
  deadline: performance.now() + 5000,
  environment: { GH_TOKEN: "ghs_SYNTHETIC_PAGES_JOB_READER" },
});
void test("actual SDK confines deployment wire fields and credentials and awaits readback without replay", async () => {
  const calls: string[] = [];
  const adapter = await createPagesProviderOperations({
    ...sdkOptions(),
    fetch: async (input, settings) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(settings?.redirect, "manual");
      assert.equal(
        new Headers(settings?.headers).get("authorization"),
        "token ghs_SYNTHETIC_PAGES_JOB_READER",
      );
      assert.equal(new Headers(settings?.headers).get("x-github-api-version"), "2022-11-28");
      calls.push(`${settings?.method} ${url.pathname}`);
      if (settings?.method === "POST") {
        assert.equal(url.pathname, "/repos/boburning/portcove/pages/deployments");
        assert.equal(url.search, "");
        assert.ok(typeof settings.body === "string");
        assert.deepEqual(JSON.parse(settings.body), {
          artifact_id: expected.artifact_id,
          pages_build_version: expected.generation,
          oidc_token: "inert-sensitive-oidc",
        });
      } else
        assert.equal(
          url.pathname,
          `/repos/boburning/portcove/pages/deployments/${expected.generation}`,
        );
      return new Response(
        JSON.stringify(settings?.method === "POST" ? ack : { status: "succeed" }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  let guard = false;
  const provider = createPagesProviderTransport({
    operations: adapter,
    token: async () => "inert-sensitive-oidc",
  });
  const accepted = await provider.create(expected, () => {
    guard = true;
  });
  assert.ok(guard);
  assert.equal(accepted.acceptance, "pending-public-readback");
  await assert.rejects(provider.create(expected), /already attempted/);
  assert.equal((await provider.observeByGeneration(expected)).status, "succeed");
  assert.deepEqual(calls, [
    "POST /repos/boburning/portcove/pages/deployments",
    `GET /repos/boburning/portcove/pages/deployments/${expected.generation}`,
  ]);
  await assert.rejects(
    createPagesProviderOperations({
      ...sdkOptions(),
      environment: { GITHUB_TOKEN: "ghs_SYNTHETIC_WRONG_SOURCE" },
    }),
    /explicit Pages credential/,
  );
});
void test("actual SDK failed, non-200, redirected and unbounded acknowledgements stay ambiguous without retry", async () => {
  for (const mode of ["created", "server", "redirect", "oversized", "stream"] as const) {
    let calls = 0;
    const adapter = await createPagesProviderOperations({
      ...sdkOptions(),
      fetch: async () => {
        calls++;
        if (mode === "stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(Error("inert-sensitive-oidc"));
              },
            }),
          );
        if (mode === "oversized") return new Response("x".repeat(128 * 1024 + 1));
        if (mode === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://foreign.invalid" },
          });
        return new Response(JSON.stringify(ack), {
          status: mode === "created" ? 201 : 503,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const provider = createPagesProviderTransport({
      operations: adapter,
      token: async () => "inert-sensitive-oidc",
    });
    await assert.rejects(
      provider.create(expected),
      (error: Error) =>
        /pending intent/.test(error.message) && !error.message.includes("inert-sensitive-oidc"),
    );
    await assert.rejects(provider.create(expected), /already attempted/);
    assert.equal(calls, 1, mode);
  }
});
void test("actual SDK cancellation preserves the original inherited deadline and drains pending bodies", async () => {
  let calls = 0,
    cancelled = 0;
  let provider: ReturnType<typeof createPagesProviderTransport> | undefined;
  const started = performance.now();
  await assert.rejects(
    withCoordinatorDeadline(started + 1000, async () => {
      const adapter = await createPagesProviderOperations({
        ...sdkOptions(),
        fetch: async () => {
          calls++;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
          );
        },
      });
      provider = createPagesProviderTransport({
        operations: adapter,
        token: async () => "inert-token",
      });
      return provider.create(expected);
    }),
    /pending intent|phase deadline/,
  );
  assert.ok(
    performance.now() - started < 4000,
    "request must use inherited phase, not its fresh five-second allowance",
  );
  assert.ok(provider);
  await assert.rejects(provider.create(expected), /already attempted/);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});
