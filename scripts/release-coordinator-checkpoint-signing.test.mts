import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  fetchWithRetry,
  withPortcoveSigningTransport,
} from "@sigstore/sign/dist/external/fetch.js";
import {
  createCheckpointSigningTransport,
  checkpointSigningEndpoints as endpoints,
} from "./release-checkpoint-signing-transport.mts";
import { signCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-signing.mts";
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { controllerOidcSubject, capacityExecutorJobProfile } from "./assembler-job-identity.mts";
import { inspectCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import type { AppRegistrationStore } from "./release-app-registration-capture.mts";
import { isRecord } from "./runtime-values.mts";

function fetchUrl(value: Parameters<typeof fetch>[0]) {
  return typeof value === "string" ? value : value instanceof URL ? value.href : value.url;
}
function objectJson(text: string) {
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value));
  return value;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const request = {
  body: '{"inert":"token-is-not-retained"}',
  retry: 0,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
};
function memoryStore() {
  const files = new Map<string, Buffer>(),
    events: string[] = [];
  const store: AppRegistrationStore = {
    async write(name, bytes) {
      assert.ok(!files.has(name), `exclusive capture ${name}`);
      files.set(name, Buffer.from(bytes));
      events.push(name);
    },
  };
  return { store, files, events };
}

void test("patched official SDK has no ambient transport fallback or scope leakage", async () => {
  await assert.rejects(fetchWithRetry(endpoints[0], request), /scope unavailable/);
  const scopes = await Promise.all(
    [1, 2].map((n) =>
      withPortcoveSigningTransport(
        async () => ({
          async json() {
            return n;
          },
        }),
        async () => {
          await Promise.resolve();
          return (await fetchWithRetry(endpoints[0], request)).json();
        },
      ),
    ),
  );
  assert.deepEqual(scopes, [1, 2]);
  await assert.rejects(fetchWithRetry(endpoints[0], request), /scope unavailable/);
});

void test("fixed transport persists intent before two ordered POSTs without retaining the Fulcio token", async () => {
  const f = memoryStore();
  let calls = 0;
  const network = createCheckpointSigningTransport(
    f.store,
    performance.now() + 10000,
    async (url, options) => {
      const stage = calls++ === 0 ? "fulcio" : "rekor";
      assert.ok(f.files.has(`${stage}-intent.json`));
      assert.equal(fetchUrl(url), endpoints[calls - 1]);
      assert.equal(options?.method, "POST");
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      assert.equal(options.headers && new Headers(options.headers).has("authorization"), false);
      return json({ stage });
    },
  );
  assert.deepEqual(await (await network.request(endpoints[0], request)).json(), {
    stage: "fulcio",
  });
  assert.ok(
    !Buffer.concat([...f.files.values()])
      .toString()
      .includes("token-is-not-retained"),
  );
  await network.request(endpoints[1], { ...request, body: '{"public":"rekor-material"}' });
  assert.equal(network.completedRequests, 2);
  assert.equal(calls, 2);
  assert.ok(f.files.has("rekor-request.body"));
  await assert.rejects(network.request(endpoints[1], request), /recovery/);
  assert.equal(calls, 2);
});

for (const [name, url, change] of [
  ["foreign host", "https://example.invalid/api/v2/signingCert", {}],
  ["query suffix", `${endpoints[0]}?redirect=1`, {}],
  ["wrong operation", endpoints[1], {}],
  ["GET", endpoints[0], { method: "GET" }],
  ["retry", endpoints[0], { retry: 1 }],
  [
    "foreign credential",
    endpoints[0],
    { headers: { "Content-Type": "application/json", Authorization: "inert-secret" } },
  ],
  ["oversize request", endpoints[0], { body: "x".repeat(65537) }],
] as const) {
  void test(`signing transport refuses ${name} before a provider POST`, async () => {
    const f = memoryStore();
    let calls = 0;
    const network = createCheckpointSigningTransport(
      f.store,
      performance.now() + 10000,
      async () => {
        calls++;
        return json({});
      },
    );
    await assert.rejects(network.request(url, { ...request, ...change }), /recovery/);
    await assert.rejects(network.request(endpoints[0], request), /recovery/);
    assert.equal(calls, 0);
  });
}

for (const status of [302, 409, 429, 503]) {
  void test(`provider ${status} preserves original attempt without retry or conflict fetch`, async () => {
    const f = memoryStore();
    let calls = 0;
    const network = createCheckpointSigningTransport(
      f.store,
      performance.now() + 10000,
      async () => {
        calls++;
        return json({ message: "inert-secret" }, status);
      },
    );
    await assert.rejects(network.request(endpoints[0], request), /recovery/);
    await assert.rejects(network.request(endpoints[0], request), /recovery/);
    assert.equal(calls, 1);
    assert.ok(f.files.has("fulcio-intent.json"));
    assert.ok(
      !Buffer.concat([...f.files.values()])
        .toString()
        .includes("inert-secret"),
    );
  });
}

void test("Rekor response loss retains completed Fulcio effects and original Rekor request", async () => {
  const f = memoryStore();
  let calls = 0;
  const network = createCheckpointSigningTransport(f.store, performance.now() + 10000, async () => {
    if (++calls === 1) return json({ certificate: "inert" });
    throw new Error("reflected inert-secret");
  });
  await network.request(endpoints[0], request);
  await assert.rejects(
    network.request(endpoints[1], { ...request, body: '{"public":"retained"}' }),
    /recovery/,
  );
  assert.ok(f.files.has("fulcio-response.body"));
  assert.ok(f.files.has("rekor-request.body"));
  assert.equal(objectJson(f.files.get("rekor-failure.json")!.toString()).remote_effect, "unknown");
  await assert.rejects(network.request(endpoints[1], request), /recovery/);
  assert.equal(calls, 2);
});

for (const mode of [
  "length",
  "stream",
  "encoding",
  "invalid-json",
  "late-response",
  "stalled-body",
] as const) {
  void test(`bounded signing read refuses ${mode}`, async () => {
    const f = memoryStore();
    const signals: AbortSignal[] = [];
    const network = createCheckpointSigningTransport(
      f.store,
      performance.now() + (["stalled-body", "late-response"].includes(mode) ? 50 : 10000),
      async (_url, options) => {
        if (options?.signal) signals.push(options.signal);
        if (mode === "late-response") {
          await new Promise((resolve) => setTimeout(resolve, 70));
          return json({ late: true });
        }
        if (mode === "length")
          return new Response("{}", {
            headers: { "content-type": "application/json", "content-length": "65537" },
          });
        if (mode === "stream")
          return new Response("x".repeat(65537), {
            headers: { "content-type": "application/json" },
          });
        if (mode === "encoding")
          return new Response("{}", {
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          });
        if (mode === "invalid-json")
          return new Response("invalid", { headers: { "content-type": "application/json" } });
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    await assert.rejects(network.request(endpoints[0], request), /recovery/);
    assert.ok(signals[0]?.aborted);
    assert.equal(network.completedRequests, 0);
    if (mode === "late-response") {
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok(!f.files.has("fulcio-response.body"));
    }
    if (mode === "invalid-json")
      assert.equal(f.files.get("fulcio-response.body")?.toString(), "invalid");
  });
}

void test("overlapping SDK requests cannot issue a second provider POST", async () => {
  const f = memoryStore();
  let release!: () => void,
    calls = 0;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const network = createCheckpointSigningTransport(f.store, performance.now() + 10000, async () => {
    calls++;
    await wait;
    return json({});
  });
  const first = network.request(endpoints[0], request);
  await assert.rejects(network.request(endpoints[0], request), /recovery/);
  release();
  await first;
  assert.equal(calls, 1);
});

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
function producerFixture() {
  const f = checkpointProofFixture(),
    memory = memoryStore();
  const profile = capacityExecutorJobProfile("coordinator"),
    now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "sigstore",
    sub: controllerOidcSubject(f.producer.controller_ref, profile.environment),
    repository: "boburning/portcove",
    repository_id: "1354613114",
    repository_owner: "boburning",
    repository_owner_id: "43177418",
    actor_id: f.producer.actor_id,
    ref: f.producer.controller_ref,
    ref_type: "tag",
    sha: f.producer.controller_revision,
    workflow_sha: f.producer.controller_revision,
    workflow_ref: `boburning/portcove/${profile.workflow}@${f.producer.controller_ref}`,
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    environment: profile.environment,
    run_id: f.producer.run_id,
    run_attempt: String(f.producer.run_attempt),
    check_run_id: f.producer.check_run_id,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
  };
  let seen = false,
    token = "",
    publicKey = "";
  const posts: string[] = [];
  const options: NonNullable<Parameters<typeof signCoordinatorCheckpointEvidence>[5]> = {
    environment: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert-runner-bearer",
    },
    async createStore() {
      assert.equal(seen, false, "retained attempt refused");
      seen = true;
      return memory.store;
    },
    identity: {
      async readKeys() {
        return {
          keys: [
            {
              ...pair.publicKey.export({ format: "jwk" }),
              kid: "fixture",
              alg: "RS256",
              use: "sig",
            },
          ],
        };
      },
      transport: {
        cwd: os.tmpdir(),
        spawn(_cmd, args) {
          const endpoint = args.find((arg) => arg.startsWith("repos/"));
          let body: unknown;
          const job = { ...f.job, status: "in_progress", completed_at: null };
          if (endpoint?.endsWith("/actions/runs/9988"))
            body = { ...f.attempt, status: "in_progress" };
          else if (endpoint?.includes("/jobs?")) body = { total_count: 1, jobs: [job] };
          else if (endpoint?.endsWith("/actions/jobs/501")) body = job;
          else assert.fail(`unexpected inert provider route ${endpoint}`);
          return {
            status: 0,
            stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`,
            stderr: "",
          };
        },
      },
    },
    async fetcher(url, settings) {
      if (fetchUrl(url).startsWith("https://fixture.actions.githubusercontent.com/token")) {
        const unsigned = [
          Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fixture" })).toString(
            "base64url",
          ),
          Buffer.from(JSON.stringify(claims)).toString("base64url"),
        ].join(".");
        token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), pair.privateKey).toString("base64url")}`;
        return json({ value: token });
      }
      posts.push(fetchUrl(url));
      if (fetchUrl(url) === endpoints[0]) {
        const body = objectJson(Buffer.from(settings?.body as Uint8Array).toString());
        assert.ok(isRecord(body.credentials));
        assert.equal(body.credentials.oidcIdentityToken, token);
        assert.ok(isRecord(body.publicKeyRequest));
        assert.ok(isRecord(body.publicKeyRequest.publicKey));
        assert.ok(typeof body.publicKeyRequest.publicKey.content === "string");
        assert.ok(typeof body.publicKeyRequest.proofOfPossession === "string");
        publicKey = body.publicKeyRequest.publicKey.content;
        assert.ok(
          verify(
            "sha256",
            Buffer.from(claims.sub),
            publicKey,
            Buffer.from(body.publicKeyRequest.proofOfPossession, "base64"),
          ),
        );
        return json({
          signedCertificateEmbeddedSct: {
            chain: {
              certificates: [
                "-----BEGIN CERTIFICATE-----\naW5lcnQtY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----",
              ],
            },
          },
        });
      }
      assert.equal(fetchUrl(url), endpoints[1]);
      const body: unknown = JSON.parse(Buffer.from(settings?.body as Uint8Array).toString());
      return json(
        {
          fixture: {
            body: Buffer.from(JSON.stringify(body)).toString("base64"),
            integratedTime: now,
            logID: "a".repeat(64),
            logIndex: 1,
            verification: { signedEntryTimestamp: "aW5lcnQ=" },
          },
        },
        201,
      );
    },
  };
  return {
    ...f,
    ...memory,
    claims,
    posts,
    options,
    token: () => token,
    publicKey: () => publicKey,
  };
}

void test("final custody cannot return success after its original signing deadline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-checkpoint-final-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-read-only-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const f = producerFixture(),
    write = f.store.write;
  f.store.write = async (name, bytes) => {
    await write(name, bytes);
    if (name === "signing-result.json") clock += 10001;
  };
  await withReadOnlyReleaseChildren(directory, async () => {
    await assert.rejects(
      signCoordinatorCheckpointEvidence(
        directory,
        f.checkpoint,
        f.configuration,
        f.expected,
        clock + 10000,
        f.options,
      ),
      /recovery/,
    );
  });
  assert.deepEqual(f.posts, endpoints);
  assert.ok(f.files.has("bundle.json"));
  assert.ok(f.files.has("signing-failure.json"));
});

for (const missing of ["keys", "spawn"] as const) {
  void test(`partial injection missing ${missing} refuses before live identity fallback`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-checkpoint-injection-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-read-only-token";
    let liveReads = 0;
    const f = producerFixture(),
      keys = await f.options.identity!.readKeys!();
    t.mock.method(globalThis, "fetch", async () => {
      liveReads++;
      return json(keys);
    });
    t.mock.method(childProcess, "spawnSync", () => {
      liveReads++;
      throw new Error("inert fallback trap; no process started");
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    });
    if (missing === "keys") delete f.options.identity!.readKeys;
    else delete f.options.identity!.transport!.spawn;
    await withReadOnlyReleaseChildren(directory, async () => {
      await assert.rejects(
        signCoordinatorCheckpointEvidence(
          directory,
          f.checkpoint,
          f.configuration,
          f.expected,
          performance.now() + 10000,
          f.options,
        ),
        /complete injected/,
      );
    });
    assert.equal(liveReads, 0);
    assert.equal(f.posts.length, 0);
    assert.equal(f.files.size, 0);
  });
}

for (const encoding of ["plain", "json-escaped"] as const) {
  void test(`successful reflected-token ${encoding} response cannot enter retained custody`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "portcove-checkpoint-token-reflection-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-read-only-token";
    t.after(() => {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    });
    const f = producerFixture(),
      fetcher = f.options.fetcher!;
    f.options.fetcher = async (url, settings) => {
      const response = await fetcher(url, settings);
      if (fetchUrl(url) !== endpoints[0]) return response;
      const text = JSON.stringify({ credentials: { oidcIdentityToken: f.token() } });
      return new Response(encoding === "plain" ? text : text.replaceAll(".", "\\u002e"), {
        headers: { "content-type": "application/json" },
      });
    };
    await withReadOnlyReleaseChildren(directory, async () => {
      await assert.rejects(
        signCoordinatorCheckpointEvidence(
          directory,
          f.checkpoint,
          f.configuration,
          f.expected,
          performance.now() + 10000,
          f.options,
        ),
        /recovery/,
      );
    });
    assert.deepEqual(f.posts, [endpoints[0]]);
    const retained = Buffer.concat([...f.files.values()]).toString();
    assert.ok(!retained.includes(f.token()));
    assert.ok(!retained.includes(f.token().replaceAll(".", "\\u002e")));
    assert.ok(!f.files.has("fulcio-response.body"));
  });
}

void test("actual official SDK produces an ephemeral signature and canonical consumer handoff using inert providers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-checkpoint-signing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-read-only-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const f = producerFixture();
  await withReadOnlyReleaseChildren(directory, async () => {
    const result = await signCoordinatorCheckpointEvidence(
      directory,
      f.checkpoint,
      f.configuration,
      f.expected,
      performance.now() + 10000,
      f.options,
    );
    assert.equal(result.evidence_scope, "injected-provider");
    assert.equal(result.authority, "none");
    inspectCoordinatorCheckpointEvidence(f.checkpoint, f.configuration, result.evidence);
    const envelope = objectJson(result.evidence.bundle.toString()).dsseEnvelope;
    assert.ok(isRecord(envelope));
    assert.ok(typeof envelope.payload === "string");
    assert.ok(Array.isArray(envelope.signatures));
    const signature: unknown = envelope.signatures[0];
    assert.ok(isRecord(signature));
    assert.ok(typeof signature.sig === "string");
    const payload = Buffer.from(envelope.payload, "base64"),
      type = "application/vnd.in-toto+json";
    const pae = Buffer.concat([
      Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
      payload,
    ]);
    assert.ok(verify("sha256", pae, f.publicKey(), Buffer.from(signature.sig, "base64")));
    assert.deepEqual(f.posts, endpoints);
    assert.ok(f.files.has("signing-result.json"));
    assert.ok(
      !Buffer.concat([...f.files.values()])
        .toString()
        .includes(f.token()),
    );
    await assert.rejects(
      signCoordinatorCheckpointEvidence(
        directory,
        f.checkpoint,
        f.configuration,
        f.expected,
        performance.now() + 10000,
        f.options,
      ),
      /retained attempt/,
    );
    assert.equal(f.posts.length, 2);
  });
});

for (const wrong of ["issuer", "job", "check", "source"] as const) {
  void test(`live producer ${wrong} mismatch cannot reach Fulcio`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-checkpoint-refusal-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-read-only-token";
    t.after(() => {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    });
    const f = producerFixture();
    if (wrong === "issuer") f.claims.iss = "https://example.invalid";
    if (wrong === "source") f.claims.sha = "f".repeat(40);
    if (wrong === "check") f.expected.producer.check_run_id = "778";
    if (wrong === "job") f.expected.producer.job_id = "502";
    await withReadOnlyReleaseChildren(directory, async () => {
      await assert.rejects(
        signCoordinatorCheckpointEvidence(
          directory,
          f.checkpoint,
          f.configuration,
          f.expected,
          performance.now() + 10000,
          f.options,
        ),
        /identity refused/,
      );
    });
    assert.equal(f.posts.length, 0);
    assert.ok(f.files.has("signing-failure.json"));
  });
}
