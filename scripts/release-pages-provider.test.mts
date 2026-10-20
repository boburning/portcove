import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createPagesProviderTransport, isTerminalPagesFailure } from "./release-pages-provider.mts";

const expected = {
  artifact_id: 12,
  controller_revision: "a".repeat(40),
  generation: "b".repeat(64),
};
const ack = {
  id: "provider-id",
  status_url: "https://api.github.com/repos/boburning/portcove/pages/deployments/provider-id",
  page_url: "https://boburning.github.io/portcove/",
};
const response = (body: unknown, status = 200) => ({
  status,
  body,
  headers: new Map<string, string>(),
});

void test("one phase deadline covers credential delay, pre-POST guard and ambiguous late acknowledgement", async () => {
  let posts = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deadline = performance.now() + 100;
  const provider = createPagesProviderTransport(
    ".",
    {
      token: async () => {
        await blocked;
        return "inert-token";
      },
      api: {
        request: () => {
          posts++;
          return response(ack);
        },
      },
    },
    deadline,
  );
  const attempt = provider.create(expected);
  await new Promise((resolve) => setTimeout(resolve, 110));
  release();
  await assert.rejects(attempt, /phase deadline/);
  assert.equal(posts, 0);
  await assert.rejects(provider.create(expected), /already attempted/);
  assert.throws(() => provider.observe({ ...expected, id: ack.id }), /phase deadline/);
  assert.throws(() => createPagesProviderTransport(".", {}, Number.NaN), /phase deadline/);
  const late = createPagesProviderTransport(
    ".",
    {
      token: async () => "inert-token",
      api: {
        request: () => {
          posts++;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 110);
          return response(ack);
        },
      },
    },
    performance.now() + 100,
  );
  await assert.rejects(late.create(expected), /phase deadline/);
  assert.equal(posts, 1);
  await assert.rejects(late.create(expected), /already attempted/);
});

void test("documented Pages acknowledgement URLs remain fixed and recognized terminal statuses retain refusal", async () => {
  const provider = createPagesProviderTransport(".", {
    token: async () => "inert-token",
    api: {
      request: () =>
        response({
          ...ack,
          status_url: `${ack.status_url}/status`,
          page_url: "boburning.github.io/portcove/",
        }),
    },
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
void test("controls expiring during token acquisition refuse before the POST and cannot repeat", async () => {
  let clock = 0,
    posts = 0;
  const provider = createPagesProviderTransport(".", {
    token: async () => {
      clock = 60001;
      return "inert-token";
    },
    api: {
      request: () => {
        posts++;
        return response(ack);
      },
    },
  });
  await assert.rejects(
    provider.create(expected, () => {
      if (clock >= 60000) throw new Error("controls expired");
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
  let tokenCalls = 0;
  let posts = 0;
  const provider = createPagesProviderTransport(".", {
    token: () => {
      tokenCalls++;
      return token;
    },
    api: {
      request() {
        posts++;
        return response(ack);
      },
    },
  });
  const first = provider.create(expected);
  const refused = assert.rejects(provider.create(expected), /already attempted/u);
  assert.equal(tokenCalls, 1);
  assert.equal(posts, 0);
  release("inert-token");
  await Promise.all([first, refused]);
  assert.equal(posts, 1);
});

void test("fixed Pages POST carries only actual opaque artifact/source and ephemeral audience token; acknowledgement is not acceptance", async () => {
  const calls: unknown[] = [];
  const provider = createPagesProviderTransport(".", {
    token: async () => "inert-token",
    api: {
      request(method, endpoint, body) {
        calls.push({ method, endpoint, body });
        return response(ack);
      },
    },
  });
  const receipt = await provider.create(expected);
  assert.deepEqual(calls, [
    {
      method: "POST",
      endpoint: "repos/boburning/portcove/pages/deployments",
      body: { artifact_id: 12, pages_build_version: "a".repeat(40), oidc_token: "inert-token" },
    },
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
    const provider = createPagesProviderTransport(".", {
      token: async () => "inert-sensitive",
      api: {
        request() {
          calls++;
          if (outcome === "lost") throw new Error("inert-sensitive");
          if (outcome === "refused") return response({ message: "inert-sensitive" }, 403);
          return response(
            outcome === "foreign" ? { ...ack, page_url: "https://foreign.invalid/" } : {},
          );
        },
      },
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
  const provider = createPagesProviderTransport(".", {
    token: async () => {
      throw Error("must not acquire");
    },
    api: {
      request() {
        throw Error("must not fetch");
      },
    },
  });
  for (const bad of [
    { artifact_id: -1 },
    { controller_revision: "main" },
    { generation: "unknown" },
    { extra: true },
  ])
    await assert.rejects(provider.create({ ...expected, ...bad }), /identity is unavailable/u);
});

void test("status observation is bounded fixed-route and never establishes public bytes or deployment actor", () => {
  const calls: unknown[] = [];
  const provider = createPagesProviderTransport(".", {
    api: {
      request(method, endpoint) {
        calls.push({ method, endpoint });
        return response({ status: "succeed" });
      },
    },
  });
  const observed = provider.observe({ ...expected, id: "provider-id" });
  assert.equal(observed.stage, "provider-status-only");
  assert.equal(observed.acceptance, "pending-public-readback");
  assert.deepEqual(calls, [
    { method: "GET", endpoint: "repos/boburning/portcove/pages/deployments/provider-id" },
  ]);
  assert.throws(
    () => provider.observe({ ...expected, id: "../other" }),
    /identity is unavailable/u,
  );
  assert.equal(calls.length, 1);
});
