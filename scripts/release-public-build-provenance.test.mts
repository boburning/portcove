import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import { assembleReleaseArtifacts } from "./release-artifact-assembly.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { isRecord } from "./runtime-values.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import {
  inspectPublicBuildInputBinding,
  selectPublicBuildInputBinding,
  requirePublicBuildInputProviderBinding,
  requireStablePublicBuildInputEvidence,
  verifyReleasePublicBuildInputs,
  requireVerifiedReleasePublicBuildInputs,
  readVerifiedReleasePublicBuildInputFiles,
} from "./release-public-build-provenance.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

void test("Windows public provenance binds one complete immutable Windows archive to the explicit profile", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t, true, "initial-beta-windows-x86_64-v1");
  const evidence = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  const binding = selectPublicBuildInputBinding(f.configuration, evidence);
  assert.deepEqual(binding, f.binding);
  assert.deepEqual(
    binding.artifacts.map((artifact) => artifact.platform),
    ["windows-x86_64"],
  );
  const result = await verifyReleasePublicBuildInputs(f.root, binding, evidence, f.options);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.platform, "windows-x86_64");
  assert.equal(result.evidence_scope, "injected-provider");
  await assert.rejects(requireVerifiedReleasePublicBuildInputs(result));
  assert.deepEqual((await inspectTrustedAssemblyInput(f.request)).labels, ["windows-x86_64"]);
  for (const artifacts of [
    [],
    [...binding.artifacts, binding.artifacts[0]],
    [{ ...binding.artifacts[0], platform: "linux-x86_64" }],
  ])
    assert.throws(() => inspectPublicBuildInputBinding({ ...binding, artifacts }));
  assert.throws(() => inspectPublicBuildInputBinding(binding, "initial-beta-win-linux"));
  assert.throws(() =>
    inspectPublicBuildInputBinding({ ...binding, release_profile: "initial-beta-windows" }),
  );
  const missing = structuredClone(evidence);
  missing.artifacts = missing.artifacts.filter(
    (artifact) => !artifact.name.startsWith("release-public-build-inputs-windows"),
  );
  assert.throws(() => selectPublicBuildInputBinding(f.configuration, missing));
});

void test("schema-2 appointed profile survives both immutable public archives and rejects a substituted recipe", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t, true);
  let evidence = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  const result = await verifyReleasePublicBuildInputs(f.root, f.binding, evidence, f.options);
  assert.equal(result.receipts.length, 2);
  for (const receipt of result.receipts) {
    assert.equal(receipt.schema_version, 2);
    assert.equal(receipt.initial_root_profile, "single-owner-one-of-one-v1");
    assert.equal(receipt.root_sha256, f.prepared.receipt.root_sha256);
    assert.equal(receipt.manifest_sha256, f.configuration.manifest_sha256);
  }
  const receipt: unknown = JSON.parse(f.publicFiles.get("build-inputs.json")!.toString("utf8"));
  assert.ok(isRecord(receipt));
  receipt.initial_root_profile = "legacy-two-of-three-v1";
  f.publicFiles.set("build-inputs.json", Buffer.from(JSON.stringify(receipt)));
  f.replacePublicArchive();
  evidence = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  await assert.rejects(
    verifyReleasePublicBuildInputs(f.root, f.binding, evidence, f.options),
    CoordinatorRemoteError,
  );
});

void test("schema3 binds complete exact immutable public inputs through actual package assembly without claiming compiler contents", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const { accepted } = await inspectTrustedAssemblyInput(f.request);
  assert.deepEqual(accepted.public_build_inputs, f.binding);
  const evidence = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  assert.deepEqual(selectPublicBuildInputBinding(f.configuration, evidence), f.binding);
  const result = await assembleReleaseArtifacts(
    f.root,
    f.request,
    f.archives,
    f.expected,
    f.options,
  );
  assert.equal(result.aggregate.output_files.length, 7);
  assert.deepEqual(result.public_build_inputs?.binding, f.binding);
  assert.equal(result.public_build_inputs?.receipts.length, 2);
  assert.equal(result.original_compiler, null);
  assert.equal(result.authority, "none");
  assert.match(result.public_build_inputs.scope, /no compiler-content or execution claim/);
  await assert.rejects(
    requireVerifiedReleasePublicBuildInputs(result.public_build_inputs),
    /actual same-process/,
  );
  await assert.rejects(
    requireVerifiedReleasePublicBuildInputs(structuredClone(result.public_build_inputs)),
    /actual same-process/,
  );
  await assert.rejects(
    readVerifiedReleasePublicBuildInputFiles(result.public_build_inputs),
    /actual same-process/,
  );
  for (const receipt of result.public_build_inputs.receipts) {
    assert.equal(receipt.manifest_sha256, f.configuration.manifest_sha256);
    assert.equal(receipt.root_sha256, f.prepared.receipt.root_sha256);
    assert.equal(receipt.tauri_configuration_sha256, f.prepared.receipt.tauri_configuration_sha256);
  }
});

void test("public matrix, numeric identity and attempt names must match independent complete provider evidence", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const evidence = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  for (const binding of [
    { ...f.binding, artifacts: f.binding.artifacts.slice(1) },
    { ...f.binding, artifacts: [f.binding.artifacts[0], f.binding.artifacts[0]] },
    { ...f.binding, artifacts: f.binding.artifacts.map((a) => ({ ...a, artifact_id: "10" })) },
    { ...f.binding, artifacts: f.binding.artifacts.map((a) => ({ ...a, bytes: 1024 * 1024 + 1 })) },
    {
      ...f.binding,
      artifacts: f.binding.artifacts.map((a) => ({ ...a, platform: "macos-aarch64" })),
    },
  ])
    assert.throws(() => inspectPublicBuildInputBinding(binding));
  for (const patch of [
    { expired: true },
    { name: "release-public-build-inputs-linux-x86_64-12345-2" },
    { bytes: 22 },
    { archive_sha256: "0".repeat(64) },
  ]) {
    const changed = structuredClone(evidence);
    const item = changed.artifacts.find((a) => a.id === f.binding.artifacts[0]!.artifact_id)!;
    Object.assign(item, patch);
    assert.throws(
      () => requirePublicBuildInputProviderBinding(f.binding, changed),
      /provider inventory/,
    );
  }
  const duplicate = structuredClone(evidence);
  duplicate.artifacts.push({ ...duplicate.artifacts.find((a) => a.id === 10)!, id: 12 });
  assert.throws(
    () => requirePublicBuildInputProviderBinding(f.binding, duplicate),
    /provider inventory/,
  );
  await assert.rejects(
    inspectTrustedAssemblyInput({ ...f.request, release_profile: "full" }),
    /schema/,
  );
});

void test("public inputs refuse manifest substitution and altered generated configuration or receipt even with matching ZIP identities", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  let evidence = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  await assert.rejects(
    verifyReleasePublicBuildInputs(
      f.root,
      { ...f.binding, manifest_sha256: "f".repeat(64) },
      evidence,
      f.options,
    ),
  );
  for (const name of ["tauri.release-public.conf.json", "build-inputs.json"]) {
    const original = f.publicFiles.get(name)!;
    f.publicFiles.set(
      name,
      Buffer.from(
        name === "build-inputs.json"
          ? '{"authority":"accepted"}'
          : '{"bundle":{"createUpdaterArtifacts":false}}',
      ),
    );
    f.replacePublicArchive();
    evidence = await collectReleaseRunEvidence(f.expected, {
      read: async (endpoint) => f.api.request("GET", endpoint),
    });
    await assert.rejects(
      verifyReleasePublicBuildInputs(f.root, f.binding, evidence, f.options),
      CoordinatorRemoteError,
    );
    f.publicFiles.set(name, original);
  }
});

void test("ZIP structural and represented-size refusals precede extraction and preserve opaque archive evidence", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  for (const bytes of [
    createAuditZip(
      [...f.publicFiles]
        .filter(([name]) => name !== "root.json")
        .map(([name, content]) => [name, content, { descriptor: true }]),
    ),
    createAuditZip(
      [...f.publicFiles]
        .map(([name, content]) => [name, content, { descriptor: true }] as const)
        .concat([["../escape", Buffer.from("inert"), { descriptor: true }]]),
    ),
    (() => {
      const bytes = Buffer.from(f.blobs.get(10)!);
      const offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      assert.ok(offset >= 0);
      bytes.writeUInt32LE(0xffffffff, offset + 24);
      return bytes;
    })(),
  ]) {
    for (const item of f.binding.artifacts) {
      item.bytes = bytes.length;
      item.sha256 = hash(bytes);
      f.blobs.set(item.artifact_id, bytes);
    }
    const evidence = await collectReleaseRunEvidence(f.expected, {
      read: async (endpoint) => f.api.request("GET", endpoint),
    });
    let failure: unknown;
    try {
      await verifyReleasePublicBuildInputs(f.root, f.binding, evidence, f.options);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof CoordinatorRemoteError && isRecord(failure.evidence));
    assert.equal(failure.evidence.phase, "raw-zip-preflight");
    assert.equal(typeof failure.evidence.directory, "string");
    const directory = String(failure.evidence.directory);
    assert.deepEqual((await readdir(directory)).sort(), ["failure.json", "linux-x86_64.zip"]);
    assert.deepEqual(await readFile(path.join(directory, "linux-x86_64.zip")), bytes);
  }
});

void test("public provider drift refuses the integrated aggregate and preserves prior public collection", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const before = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  f.state.drift = true;
  const after = await collectReleaseRunEvidence(f.expected, {
    read: async (endpoint) => f.api.request("GET", endpoint),
  });
  assert.throws(
    () => requireStablePublicBuildInputEvidence(f.binding, before, after),
    /provider inventory/,
  );
  f.state.reads = 0;
  await assert.rejects(
    assembleReleaseArtifacts(f.root, f.request, f.archives, f.expected, f.options),
    /retain owned directory/,
  );
  assert.ok((await readdir(f.root)).some((name) => name.startsWith("artifact-assembly-")));
});

void test("the configured SDK reads public build archives with one accounted lookup each", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const evidence = await collectReleaseRunEvidence(f.expected, f.options.evidence);
  const seen: string[] = [];
  let reservations = 0;
  let settlements = 0;
  let elapsed = 0;
  const oldToken = process.env.GH_TOKEN;
  t.after(() => {
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
  });
  process.env.GH_TOKEN = "inert-fixed-public-reader";
  const deadline = performance.now() + 10000;
  await withReadOnlyReleaseChildren(f.root, async () => {
    process.env.GH_TOKEN = "inert-ambient-replacement";
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const headers = new Headers(init?.headers);
        assert.equal(init?.redirect, "manual");
        if (url.origin === "https://api.github.com") {
          const id = Number(url.pathname.split("/").at(-2));
          assert.equal(url.pathname, `/repos/boburning/portcove/actions/artifacts/${id}/zip`);
          assert.equal(headers.get("authorization"), "token inert-fixed-public-reader");
          seen.push(`lookup:${id}`);
          return new Response(null, {
            status: 302,
            headers: {
              location: `https://productionresultssa10.blob.core.windows.net/actions-results/${id}?sig=inert`,
              link: "<https://productionresultssa10.blob.core.windows.net/actions-results/archive?sig=inert>",
              "x-github-request-id": "inert-build-request",
              "x-ratelimit-limit": "5000",
              "x-untrusted": "inert-opaque-data",
            },
          });
        }
        assert.equal(url.origin, "https://productionresultssa10.blob.core.windows.net");
        assert.equal(init?.credentials, "omit");
        assert.equal(headers.has("authorization"), false);
        const id = Number(url.pathname.split("/").at(-1));
        seen.push(`delivery:${id}`);
        return new Response(Uint8Array.from(f.blobs.get(id)!));
      },
    );
    const result = await withCoordinatorDeadline(deadline, () =>
      verifyReleasePublicBuildInputs(f.root, f.binding, evidence, {
        deadline: deadline + 30000,
        lookup: () => ({
          reserve(request) {
            assert.equal(request.replay, "once");
            assert.equal(request.url.origin, "https://api.github.com");
            reservations++;
            return {
              consumeBytes() {},
              settle(observation) {
                assert.equal(observation.dispatched, true);
                assert.equal(observation.status, 302);
                assert.equal(observation.bytes, 0);
                assert.equal(observation.rate?.limit, 5000);
                assert.deepEqual(observation.headers, {
                  "x-github-request-id": "inert-build-request",
                  "x-ratelimit-limit": "5000",
                });
                settlements++;
              },
            };
          },
          elapsed(milliseconds) {
            assert.ok(milliseconds >= 0);
            elapsed++;
          },
        }),
      }),
    );
    await requireVerifiedReleasePublicBuildInputs(result);
    assert.deepEqual(
      seen,
      f.binding.artifacts.flatMap(({ artifact_id: id }) => [`lookup:${id}`, `delivery:${id}`]),
    );
    assert.equal(reservations, f.binding.artifacts.length);
    assert.equal(settlements, reservations);
    assert.equal(elapsed, reservations);
    const completedRequests = [...seen];
    await assert.rejects(
      verifyReleasePublicBuildInputs(f.root, f.binding, evidence, {
        deadline,
        lookup: () => ({
          deadline: performance.now() - 1,
          reserve: () => assert.fail("expired evidence scope must not reserve"),
        }),
      }),
      CoordinatorRemoteError,
    );
    assert.deepEqual(seen, completedRequests);

    await assert.rejects(
      verifyReleasePublicBuildInputs(f.root, f.binding, evidence, {
        deadline: performance.now() - 1,
        download: async () => assert.fail("expired caller must not dispatch injected downloader"),
      }),
      CoordinatorRemoteError,
    );
  });
});

void test("a tighter coordinator deadline cancels public build delivery without opening a second lookup", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const evidence = await collectReleaseRunEvidence(f.expected, f.options.evidence);
  let lookups = 0;
  let transfers = 0;
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://api.github.com") {
      lookups++;
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://productionresultssa10.blob.core.windows.net/actions-results/archive?sig=inert",
        },
      });
    }
    transfers++;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const deadline = performance.now() + 150;
  await assert.rejects(
    withCoordinatorDeadline(deadline, () =>
      verifyReleasePublicBuildInputs(f.root, f.binding, evidence, {
        credential: { kind: "explicit", token: "inert-public-reader" },
        deadline: deadline + 30000,
      }),
    ),
    CoordinatorRemoteError,
  );
  assert.equal(lookups, 1);
  assert.equal(transfers, 1);
  assert.equal(cancelled, true);
});

void test("actual assembly uses the explicit evidence credential for public archives without ambient authentication", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  for (const [name, value] of [
    ["GH_TOKEN", undefined],
    ["GITHUB_TOKEN", undefined],
    ["CI", "true"],
  ] as const) {
    const prior = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    });
  }
  let dispatched = 0;
  let admitted = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    dispatched++;
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(
      url.pathname,
      `/repos/boburning/portcove/actions/artifacts/${f.binding.artifacts[0]!.artifact_id}/zip`,
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "token inert-explicit-public-reader",
    );
    admitted = true;
    return Response.json({ message: "refused inert lookup" }, { status: 503 });
  });
  await assert.rejects(
    assembleReleaseArtifacts(f.root, f.request, f.archives, f.expected, {
      evidence: {
        ...f.options.evidence,
        credential: { kind: "explicit", token: "inert-explicit-public-reader" },
      },
    }),
  );
  assert.equal(dispatched, 1);
  assert.equal(admitted, true);
});
