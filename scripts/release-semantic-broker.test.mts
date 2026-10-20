import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  authenticateCapturedSemanticIssuer,
  prepareSemanticAppJwt,
} from "./release-semantic-issuer.mts";
import { inspectSemanticIssuerRequest } from "./release-semantic-issuer-http.mts";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";
import { collectReleaseSourceChanges } from "./release-source-changes.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import {
  prepareFrozenSemanticInputs,
  prepareFrozenSemanticProposalInputs,
  requireFrozenSemanticProposalInputs,
  requireFrozenSemanticInputs,
  readSemanticPublicationBaseline,
} from "./release-semantic-inputs.mts";
import {
  inspectSemanticRuntimeEvents,
  inspectSemanticFixtureEvents,
  requireDirectSemanticCapture,
  requireLinuxSemanticSettlement,
  readQualifiedSemanticExecutable,
  semanticSupervisorEnvironment,
  requireDirectSemanticProposalCapture,
  requireDirectSemanticRefusalCapture,
  prepareCapturedSemanticDisposition,
  requireDirectSemanticDispositionCapture,
} from "./release-semantic-runtime.mts";
import { createReleaseReviewRequest } from "./release-review-request.mts";
import { inspectSemanticProposalResult } from "./release-semantic-proposal.mts";
import { prepareSemanticReviewHandoff } from "./release-semantic-review.mts";
import {
  readbackSemanticCheck,
  publishSemanticCapture,
  publishSemanticDispositionCapture,
} from "./release-semantic-broker.mts";
import { capacityDigest } from "./release-capacity.mts";
import {
  createSemanticBundleReader,
  createSemanticReaderRpc,
  materializeSemanticReaderIndex,
  materializeSemanticProposalReaderIndex,
} from "./release-semantic-reader.mts";
import {
  inspectSemanticReaderIndex,
  createSemanticSnapshotReader,
} from "./release-semantic-reader-core.mts";
import { isRecord } from "./runtime-values.mts";

void test("issuer transport pins App/token routes and the exact captured Check body without ambient credentials", async () => {
  const body = {
    name: "Portcove independent release semantic review",
    head_sha: "a".repeat(40),
    output: { summary: "inert only" },
  };
  const request = {
    configuration: {
      app_id: 123,
      installation_id: 456,
      head: "a".repeat(40),
      check_body_sha256: capacityDigest(body),
    },
    kind: "installation",
    token: "inert-not-a-credential",
    method: "POST",
    endpoint: "repos/boburning/portcove/check-runs",
    body,
  };
  assert.equal(inspectSemanticIssuerRequest(request).endpoint, request.endpoint);
  for (const change of [
    { endpoint: "https://elsewhere.invalid/check-runs" },
    { endpoint: "repos/other/portcove/check-runs" },
    { body: { ...body, head_sha: "b".repeat(40) } },
    { token: "inert\r\nheader" },
    { kind: "app" },
    { method: "DELETE" },
  ])
    assert.throws(() => inspectSemanticIssuerRequest({ ...request, ...change }));
  assert.doesNotThrow(() =>
    inspectSemanticIssuerRequest({
      ...request,
      method: "GET",
      body: null,
      endpoint: `repos/boburning/portcove/commits/${"a".repeat(40)}/check-runs?filter=all&per_page=100&page=16`,
    }),
  );
  assert.throws(() =>
    inspectSemanticIssuerRequest({
      ...request,
      method: "GET",
      body: null,
      endpoint: `repos/boburning/portcove/commits/${"b".repeat(40)}/check-runs?filter=all&per_page=100&page=1`,
    }),
  );
  const tokenRequest = {
    ...request,
    kind: "app",
    endpoint: "app/installations/456/access_tokens",
    body: { repository_ids: [1354613114], permissions: { checks: "write", metadata: "read" } },
  };
  assert.doesNotThrow(() => inspectSemanticIssuerRequest(tokenRequest));
  assert.throws(() =>
    inspectSemanticIssuerRequest({
      ...tokenRequest,
      body: { repository_ids: [1354613114], permissions: { checks: "write", contents: "write" } },
    }),
  );
  await assert.rejects(authenticateCapturedSemanticIssuer({} as never, {} as never), /imported/);
  await assert.rejects(
    prepareCapturedSemanticDisposition({ kind: "classification-proposal", capture: {} }),
    /imported/,
  );
  await assert.rejects(
    prepareCapturedSemanticDisposition({
      kind: "complete-opportunity",
      error: new Error("refused"),
      request: {},
    }),
    /imported/,
  );
  await assert.rejects(
    requireDirectSemanticDispositionCapture({ wire: "valid-looking imported data" }),
    /imported/,
  );
  let credentialCalls = 0;
  await assert.rejects(
    publishSemanticDispositionCapture(
      {},
      { app_id: 123, installation_id: 456, writer_app_id: 789 },
      {
        async requireProvisioningGrant() {
          credentialCalls++;
        },
        async authenticateIssuer() {
          credentialCalls++;
          throw new Error("must not run");
        },
      },
    ),
    /imported/,
  );
  assert.equal(credentialCalls, 0);
  const worker = fileURLToPath(new URL("./release-semantic-issuer-http.mts", import.meta.url));
  assert.throws(
    () =>
      execFileSync(process.execPath, [worker], {
        input: JSON.stringify({ ...request, endpoint: "never-network" }),
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    (error: unknown) => {
      assert.ok(isRecord(error));
      assert.ok(String(error.stderr).includes("semantic credential HTTP transport failed"));
      assert.equal(String(error.stderr).includes(request.token), false);
      assert.equal(String(error.stdout).includes(request.token), false);
      return true;
    },
  );
});

void test("App JWT uses the selected public key, RS256 and a bounded clock window", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const digest = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const jwt = prepareSemanticAppJwt(Buffer.from(pem), 123, digest, 1800000000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload!, "base64url").toString()), {
    iat: 1799999940,
    exp: 1800000300,
    iss: "123",
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature!, "base64url"),
    ),
    true,
  );
  assert.throws(
    () => prepareSemanticAppJwt(Buffer.from(pem), 123, "0".repeat(64), 1800000000),
    /identity changed/,
  );
});

void test("fixed Linux parent preserves verifiable resource receipts without ambient credentials", () => {
  const inherited = '{"receipt":"inert existing reservation"}';
  assert.deepEqual(
    semanticSupervisorEnvironment({
      HOME: "/home/reviewer",
      PORTCOVE_RESOURCE_RESERVATION: inherited,
      PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: "inert-native",
      GH_TOKEN: "never-forward",
      OPENAI_API_KEY: "never-forward",
      HTTP_PROXY: "never-forward",
      NODE_OPTIONS: "never-forward",
      PATH: "/caller-chosen",
      GITHUB_ACTIONS: "true",
    }),
    {
      HOME: "/home/reviewer",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      PORTCOVE_RESOURCE_RESERVATION: inherited,
      PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: "inert-native",
    },
  );
});

void test("runtime materialization rejects a changed original instead of deriving trust from its copy", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "semantic-executable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime");
  const expected = Buffer.from("independently qualified inert runtime");
  const digest = createHash("sha256").update(expected).digest("hex");
  await writeFile(file, expected);
  assert.deepEqual(await readQualifiedSemanticExecutable(file, digest), expected);
  await writeFile(file, "changed after the initial original-file check");
  await assert.rejects(readQualifiedSemanticExecutable(file, digest), /before materialization/u);
});

void test("Linux settlement requires observed limits, isolated runtime and positive complete teardown", () => {
  const settled = {
    schema_version: 1,
    mode: "codex",
    authority: "none",
    scope: "held-linux-semantic-runtime-preparation",
    unit: `portcove-semantic-${"a".repeat(32)}.service`,
    storage_bytes: 536870912,
    memory_bytes: 1073741824,
    swap_bytes: 0,
    tasks_max: 64,
    cgroup_verified: true,
    namespaces_verified: true,
    capture_complete: true,
    cgroup_empty: true,
    unit_settled: true,
    network_settled: true,
    network_refused: false,
    forced_termination: false,
    auth_refreshed: true,
    exit_code: 0,
    failure: null,
    cleanup_errors: [],
  };
  assert.doesNotThrow(() => requireLinuxSemanticSettlement(settled));
  for (const change of [
    { mode: "fixture" },
    { mode: "codex-fixture" },
    { authority: "production" },
    { storage_bytes: 1073741824 },
    { memory_bytes: 2147483648 },
    { swap_bytes: 1 },
    { tasks_max: 65 },
    { cgroup_verified: false },
    { namespaces_verified: false },
    { capture_complete: false },
    { cgroup_empty: false },
    { unit_settled: false },
    { network_settled: false },
    { network_refused: true },
    { forced_termination: true },
    { auth_refreshed: false },
    { exit_code: null },
    { exit_code: 1 },
    { failure: "ambiguous" },
    { cleanup_errors: ["unfinished"] },
  ])
    assert.throws(
      () => requireLinuxSemanticSettlement({ ...settled, ...change }),
      /positively settled/u,
    );
  // A successful imported receipt does not manufacture runtime provenance.
  assert.throws(() => requireDirectSemanticCapture(settled as never), /imported or changed/u);
});

function textReaderFixture(before: Buffer, after: Buffer) {
  const blob = (bytes: Buffer) => {
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return {
      oid,
      file: {
        name: `objects/${oid}.data`,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };
  const baseline = blob(before),
    source = blob(after);
  // Inert reader/observation fixture; no builder or runtime provenance is minted.
  const bundle = {
    manifest: {
      snapshots: {
        baseline: [{ path: "app.rs", oid: baseline.oid, mode: "100644" }],
        source: [{ path: "app.rs", oid: source.oid, mode: "100644" }],
      },
      source: {
        changes: [{ path: "app.rs", before: { oid: baseline.oid }, after: { oid: source.oid } }],
      },
    },
    files: [baseline.file, source.file],
  } as unknown as Parameters<typeof createSemanticSnapshotReader>[0];
  return { reader: createSemanticSnapshotReader(bundle), baseline, source };
}

void test("UTF8 pages preserve original byte identities and codepoint boundaries while binary remains explicit", () => {
  const bytes = Buffer.from("alpha\n🙂порт\n");
  const { reader, source } = textReaderFixture(Buffer.from("before\n"), bytes);
  const first = reader("read_text", { snapshot: "source", path: "app.rs", offset: 0, length: 7 });
  assert.ok(isRecord(first));
  assert.equal(first.data, "alpha\n");
  assert.equal(first.next, 6);
  assert.equal(first.sha256, source.file.sha256);
  const second = reader("read_text", { snapshot: "source", path: "app.rs", offset: 6, length: 4 });
  assert.ok(isRecord(second));
  assert.equal(second.data, "🙂");
  assert.equal(second.next, 10);
  assert.throws(
    () => reader("read_text", { snapshot: "source", path: "app.rs", offset: 7, length: 4 }),
    /codepoint/,
  );
  const binaryBytes = Buffer.from([0, 255, 1, 2]);
  const binary = textReaderFixture(Buffer.from("before\n"), binaryBytes).reader;
  const view = binary("read_text", { snapshot: "source", path: "app.rs", offset: 0, length: 4 });
  assert.ok(isRecord(view));
  assert.equal(view.binary, true);
  assert.equal(view.data, null);
  const raw = binary("read", { snapshot: "source", path: "app.rs", offset: 0, length: 4 });
  assert.ok(isRecord(raw) && typeof raw.data === "string");
  assert.deepEqual(Buffer.from(raw.data, "base64"), binaryBytes);
});

void test("net delta text views bind both original objects and expose truncation with original continuation offsets", () => {
  const { reader, source } = textReaderFixture(
    Buffer.from("\nold\n"),
    Buffer.from("new\n" + "x".repeat(6000)),
  );
  const diff = reader("net_diff", { path: "app.rs" });
  assert.ok(isRecord(diff) && isRecord(diff.baseline) && isRecord(diff.source));
  assert.equal(diff.baseline.data, "\nold\n");
  assert.equal(diff.source.git_oid, source.oid);
  assert.equal(diff.source.sha256, source.file.sha256);
  assert.equal(diff.source.truncated, true);
  assert.equal(diff.source.next, 4096);
  const tail = reader("read_text", {
    snapshot: "source",
    path: "app.rs",
    offset: 4096,
    length: 8192,
  });
  assert.ok(
    isRecord(tail) && typeof tail.data === "string" && typeof diff.source.data === "string",
  );
  assert.equal(Buffer.from(diff.source.data + tail.data).equals(source.file.bytes), true);
  assert.throws(() => reader("net_diff", { path: "absent" }), /frozen net delta/);
  assert.throws(() => reader("net_diff", { path: "app.rs", command: "execute" }), /unauthorized/);
});

function fixture() {
  const f = releaseSourceFixture();
  const opportunity = {
    ...f.opportunity,
    change_set_sha256: f.expectedHash,
    complete_change_set: true,
    meaningful: true,
    documentation_only: false,
    urgency: false,
    requested_channel: "preview",
    classification: {
      source_commit: f.original.sha,
      reviewed_commit: f.original.sha,
      source_tree: f.sourceTree,
      reviewed_tree: f.sourceTree,
      change_set_sha256: f.expectedHash,
      change_set_scope: "portcove-release-net-tree-delta-v1",
      base_version: "0.1.0-alpha.2",
      change: "prerelease",
      compatibility: "compatible",
    },
  };
  const response = (body: unknown) => ({ status: 200, body, headers: new Map<string, string>() });
  const release = {
    id: 1,
    draft: false,
    tag_name: "v0.1.0-alpha.2",
    published_at: "2026-01-01T00:00:00Z",
  };
  const api = {
    request(method: string, route: string) {
      assert.equal(method, "GET");
      if (route === "repos/boburning/portcove")
        return response({ id: 1354613114, full_name: "boburning/portcove" });
      if (route.includes("/releases?")) return response([release]);
      if (route.endsWith("/releases/1")) return response(release);
      if (route.includes("/git/ref/tags/"))
        return response({
          ref: "refs/tags/v0.1.0-alpha.2",
          object: { type: "commit", sha: f.base.sha },
        });
      return f.api.request(method, route);
    },
  };
  return { f, opportunity, api };
}

void test("exact Git bytes recover normalized unsigned offsets without trusting omitted provider headers", () => {
  const raw = Buffer.from(
    `tree ${"a".repeat(40)}\nauthor Example <fixture@example.invalid> 1704067200 -0400\ncommitter Example <fixture@example.invalid> 1704067200 -0400\n\nUnsigned offset fixture\n`,
  );
  const id = createHash("sha1").update(`commit ${raw.length}\0`).update(raw).digest("hex");
  const actor = { name: "Example", email: "fixture@example.invalid", date: "2024-01-01T00:00:00Z" };
  const record = {
    sha: id,
    tree: { sha: "a".repeat(40) },
    parents: [],
    author: actor,
    committer: actor,
    message: "Unsigned offset fixture",
    verification: { verified: false, reason: "unsigned", payload: null, signature: null },
  };
  assert.throws(() => inspectRemoteCommitObject(record, id), /differ/);
  assert.deepEqual(inspectRemoteCommitObject(record, id, raw).object.bytes, raw);
  for (const changed of [
    { ...record, tree: { sha: "b".repeat(40) } },
    { ...record, author: { ...actor, date: "2024-01-01T00:00:01Z" } },
    { ...record, message: "changed" },
  ])
    assert.throws(() => inspectRemoteCommitObject(changed, id, raw), /disagree/);
  assert.throws(
    () =>
      inspectRemoteCommitObject(record, id, Buffer.from(raw.toString().replace("-0400", "+0000"))),
    /differ/,
  );
  const extra = Buffer.from(raw.toString().replace("\n\n", "\nencoding invented\n\n"));
  const extraId = createHash("sha1").update(`commit ${extra.length}\0`).update(extra).digest("hex");
  assert.throws(
    () => inspectRemoteCommitObject({ ...record, sha: extraId }, extraId, extra),
    /supported headers/,
  );
});

void test("provider numeric repository comparison links retain the exact appointed repository boundary", () => {
  for (const repositoryId of [1354613114, 1354613115]) {
    const f = releaseSourceFixture(101),
      routes: string[] = [];
    const api = {
      request(method: string, route: string) {
        routes.push(route);
        const mapped = route.replace("/repositories/1354613114/", "/repos/boburning/portcove/");
        const result = f.api.request(method, mapped);
        const link = result.headers.get("link");
        return link
          ? {
              ...result,
              headers: new Map([
                [
                  "link",
                  link.replace("/repos/boburning/portcove/", `/repositories/${repositoryId}/`),
                ],
              ]),
            }
          : result;
      },
    };
    if (repositoryId === 1354613114) {
      assert.equal(collectReleaseSourceChanges(api, f.opportunity).commits.length, 101);
      assert.ok(routes.some((route) => route.includes("/repositories/1354613114/")));
    } else assert.throws(() => collectReleaseSourceChanges(api, f.opportunity), /escaped/);
  }
});

void test("frozen source collection binds actual Git blobs, publication and complete provider delta; caller mutation cannot change expected inputs", async (t) => {
  const { f, opportunity, api } = fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-semantic-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", root], { windowsHide: true });
  const git = (args: string[], input?: Buffer | string) =>
    execFileSync("git", ["-C", root, ...args], { input, windowsHide: true })
      .toString()
      .trim();
  for (const text of ["readme\n", "base\n", "source\n"])
    git(["hash-object", "-w", "--stdin"], text);
  for (const blob of [f.oldBlob, f.newBlob]) {
    const readme = git(["hash-object", "--stdin"], "readme\n");
    git(["mktree"], `100644 blob ${readme}\tREADME.md\n100644 blob ${blob}\tapp.rs\n`);
  }
  for (const commit of [f.base, f.original])
    git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      inspectRemoteCommitObject(commit, commit.sha).object.bytes,
    );
  // A hostile local replace ref must not replace the provider-bound source tree.
  git(["replace", f.original.sha, f.base.sha]);
  const bundle = prepareFrozenSemanticInputs(api, root, opportunity, {
    classification: "fixture",
    compatibility: "fixture only",
  });
  const frozen = requireFrozenSemanticInputs(bundle);
  const request = createReleaseReviewRequest({
    before_checkpoint: "a".repeat(40),
    requested_at: "2026-01-02T00:00:00.000Z",
    base_commit: opportunity.base_commit,
    base_version: opportunity.classification.base_version,
    source_commit: opportunity.source_commit,
    source_tree: opportunity.source_tree,
    change_set_sha256: opportunity.change_set_sha256,
  });
  const proposedInputs = prepareFrozenSemanticProposalInputs(api, root, request);
  assert.equal(
    requireFrozenSemanticProposalInputs(proposedInputs).manifest.opportunity.request_id,
    request.request_id,
  );
  assert.throws(
    () => requireFrozenSemanticInputs(proposedInputs as unknown as typeof bundle),
    /imported/,
  );
  assert.throws(
    () => requireFrozenSemanticProposalInputs(bundle as unknown as typeof proposedInputs),
    /imported/,
  );
  const proposalIndex = materializeSemanticProposalReaderIndex(proposedInputs);
  assert.equal(
    inspectSemanticReaderIndex(proposalIndex.bytes, proposalIndex.sha256).bundle_sha256,
    proposedInputs.bundle_sha256,
  );
  const proposalResult = {
    schema_version: 1,
    outcome: "proposed",
    request_id: request.request_id,
    bundle_sha256: proposedInputs.bundle_sha256,
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    proposal: {
      change: "prerelease",
      compatibility: "compatible",
      migration_notes: null,
      prerelease_identifier: null,
      meaningful: true,
      documentation_only: false,
      urgency: false,
    },
    report: "Inert serialization fixture only, no actual semantic judgment.",
  };
  const proposal = inspectSemanticProposalResult(proposalResult, proposedInputs);
  assert.equal(proposal.opportunity?.source_commit, request.source_commit);
  assert.equal(proposal.opportunity?.classification.base_version, request.base_version);
  for (const change of [
    { outcome: "accepted" },
    { request_id: "b".repeat(64) },
    { bundle_sha256: "b".repeat(64) },
    { coverage: { ...proposalResult.coverage, compatibility: false } },
    { proposal: { ...proposalResult.proposal, source_commit: "b".repeat(40) } },
    { outcome: "refused" },
  ])
    assert.throws(() =>
      inspectSemanticProposalResult({ ...proposalResult, ...change }, proposedInputs),
    );
  assert.equal(
    inspectSemanticProposalResult(
      { ...proposalResult, outcome: "refused", proposal: null },
      proposedInputs,
    ).opportunity,
    null,
  );
  await assert.rejects(requireDirectSemanticProposalCapture(proposal), /imported/);
  await assert.rejects(requireDirectSemanticRefusalCapture(new Error("refused")), /imported/);
  const index = materializeSemanticReaderIndex(bundle);
  assert.equal(inspectSemanticReaderIndex(index.bytes, index.sha256).files.length, 3);
  assert.throws(
    () =>
      requireFrozenSemanticInputs(
        inspectSemanticReaderIndex(index.bytes, index.sha256) as unknown as typeof bundle,
      ),
    /imported/,
  );
  assert.throws(() => inspectSemanticReaderIndex(index.bytes, "0".repeat(64)), /differs/);
  const indexPath = path.join(root, "reader-index.json");
  await writeFile(indexPath, index.bytes, { flag: "wx" });
  const server = fileURLToPath(new URL("./release-semantic-reader-server.mts", import.meta.url));
  const requests =
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read",
          arguments: { snapshot: "source", path: "app.rs", offset: 0, length: 6 },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  const lines = execFileSync(process.execPath, [server, indexPath, index.sha256], {
    input: requests,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  })
    .toString()
    .trim()
    .split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[2]!.includes(Buffer.from("source").toString("base64")));
  assert.throws(() =>
    execFileSync(process.execPath, [server, indexPath, "0".repeat(64)], {
      input: requests,
      windowsHide: true,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const reader = createSemanticBundleReader(bundle);
  assert.deepEqual(reader("list", { snapshot: "source", offset: 0 }), {
    total: 2,
    entries: frozen.manifest.snapshots.source,
    next: null,
  });
  const page = reader("read", { snapshot: "source", path: "app.rs", offset: 0, length: 6 }) as {
    data: string;
  };
  assert.equal(Buffer.from(page.data, "base64").toString(), "source");
  const listed = reader("list", { snapshot: "source", offset: 0 }) as {
    entries: { path: string; oid: string }[];
  };
  listed.entries[0]!.path = "forged";
  listed.entries[0]!.oid = "0".repeat(40);
  assert.deepEqual(reader("list", { snapshot: "source", offset: 0 }), {
    total: 2,
    entries: frozen.manifest.snapshots.source,
    next: null,
  });
  assert.deepEqual(reader("search", { snapshot: "source", literal: "source" }), {
    matches: [{ path: "app.rs", offset: 0 }],
    truncated: false,
  });
  for (const [tool, args] of [
    ["exec", { command: "candidate.exe" }],
    ["read", { snapshot: "source", path: "../../secret", offset: 0, length: 1 }],
    ["read", { snapshot: "source", path: "app.rs", offset: 0, length: 16385 }],
    ["search", { snapshot: "source", literal: "", regex: true }],
  ])
    assert.throws(() => reader(tool, args));
  const rpc = createSemanticReaderRpc(bundle);
  assert.throws(() => rpc({ jsonrpc: "2.0", id: 0, method: "tools/list" }));
  assert.ok(
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
  );
  assert.equal(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.ok(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.ok(
    rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list", arguments: { snapshot: "source", offset: 0 } },
    }),
  );
  assert.throws(() =>
    rpc({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "file:///secret" } }),
  );
  const bounded = createSemanticBundleReader(bundle);
  for (let i = 0; i < 1024; i++) bounded("list", { snapshot: "source", offset: 0 });
  assert.throws(() => bounded("list", { snapshot: "source", offset: 0 }), /lifetime call/);
  assert.equal(frozen.manifest.source.source_tree, f.sourceTree);
  assert.equal(frozen.files.length, 3);
  assert.throws(() => requireFrozenSemanticInputs(structuredClone(bundle)), /imported or changed/);
  const first = bundle.files[0]!;
  first.bytes.fill(120);
  first.sha256 = createHash("sha256").update(first.bytes).digest("hex");
  assert.throws(() => requireFrozenSemanticInputs(bundle), /differs/);
  assert.notDeepEqual(frozen.files[0]!.bytes, first.bytes);
  assert.equal(
    Buffer.from(
      (
        reader("read", { snapshot: "source", path: "app.rs", offset: 0, length: 6 }) as {
          data: string;
        }
      ).data,
      "base64",
    ).toString(),
    "source",
  );
});

void test("publication pagination cannot leave the fixed repository release inventory", () => {
  const api = fixture().api;
  const reader = {
    request(method: string, route: string) {
      const result = api.request(method, route);
      if (route.includes("/releases?"))
        return {
          ...result,
          body: Array.from({ length: 100 }, (_, id) => ({
            id,
            draft: false,
            tag_name: `v${id}`,
            published_at: "2026-01-01T00:00:00Z",
          })),
          headers: new Map([
            [
              "link",
              '<https://api.github.com/repos/elsewhere/other/releases?per_page=100&page=2>; rel="next"',
            ],
          ]),
        };
      return result;
    },
  };
  assert.throws(
    () => readSemanticPublicationBaseline(reader, "unused", "0.1.0-alpha.2"),
    /escaped/,
  );
});

void test("only explicit complete-opportunity acceptance passes event integrity; imported captures never acquire producer provenance", async () => {
  const opportunity = fixture().opportunity;
  const blob = (text: string) => {
    const bytes = Buffer.from(text);
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return {
      oid,
      file: {
        name: `objects/${oid}.data`,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };
  const before = blob("fn main() { old_behavior(); }\n"),
    after = blob("fn main() { repaired_behavior(); }\n");
  const manifest = {
    opportunity,
    opportunity_sha256: capacityDigest(opportunity),
    baseline: { commit: opportunity.base_commit },
    source: {
      changes: [{ path: "app.rs", before: { oid: before.oid }, after: { oid: after.oid } }],
    },
    evidence: {
      classification: "prerelease: preserved public contract",
      compatibility: "fixture API unchanged",
    },
    snapshots: {
      baseline: [{ path: "app.rs", oid: before.oid, mode: "100644" }],
      source: [{ path: "app.rs", oid: after.oid, mode: "100644" }],
    },
  };
  // Imported inert data exercises observation checks; it has no builder or producer brand.
  const bundle = {
    manifest,
    bundle_sha256: capacityDigest(manifest),
    files: [before.file, after.file],
  } as unknown as Parameters<typeof inspectSemanticRuntimeEvents>[1];

  const result = {
    schema_version: 1,
    outcome: "accepted",
    opportunity_sha256: bundle.manifest.opportunity_sha256,
    bundle_sha256: bundle.bundle_sha256,
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    report: "Synthetic full-scope report",
  };
  const events = (value: unknown, extra: unknown[] = []) =>
    Buffer.from(
      [
        { type: "thread.started", thread_id: "01234567-0123-0123-0123-0123456789ab" },
        { type: "turn.started" },
        ...extra,
        { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } },
        { type: "turn.completed" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
  assert.throws(() => inspectSemanticRuntimeEvents(events(result), bundle), /lacks relevant/);
  const readEvents = (
    snapshot: string,
    path: string,
    bytes: Buffer,
    length = bytes.length,
    offset = 0,
  ) => {
    const call = {
      id: `${snapshot}:${path}:${offset}`,
      type: "mcp_tool_call",
      server: "portcove_frozen_bundle",
      tool: "read",
      arguments: { snapshot, path, offset, length },
    };
    return [
      { type: "item.started", item: { ...call, status: "in_progress" } },
      {
        type: "item.completed",
        item: {
          ...call,
          status: "completed",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  bytes: bytes.length,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                  offset,
                  encoding: "base64",
                  data: bytes.subarray(offset, offset + length).toString("base64"),
                  next: offset + length < bytes.length ? offset + length : null,
                }),
              },
            ],
          },
          error: null,
        },
      },
    ];
  };
  const metadata = readEvents("manifest", "manifest.json", Buffer.from(JSON.stringify(manifest)));
  const meaningful = [
    ...metadata,
    ...readEvents("baseline", "app.rs", before.file.bytes),
    ...readEvents("source", "app.rs", after.file.bytes),
  ];
  assert.equal(
    inspectSemanticRuntimeEvents(events(result, meaningful), bundle).report,
    result.report,
  );
  const published = blob("fn main() { prior_published_version(); }\n");
  const preparedManifest = {
    ...manifest,
    snapshots: {
      ...manifest.snapshots,
      published: [{ path: "app.rs", oid: published.oid, mode: "100644" }],
    },
  };
  const preparedBundle = {
    ...bundle,
    manifest: preparedManifest,
    bundle_sha256: capacityDigest(preparedManifest),
    files: [...bundle.files, published.file],
  } as unknown as typeof bundle;
  const preparedResult = { ...result, bundle_sha256: preparedBundle.bundle_sha256 };
  const preparedMetadata = readEvents(
    "manifest",
    "manifest.json",
    Buffer.from(JSON.stringify(preparedManifest)),
  );
  const sourceReads = meaningful.slice(metadata.length);
  assert.throws(
    () =>
      inspectSemanticRuntimeEvents(
        events(preparedResult, [...preparedMetadata, ...sourceReads]),
        preparedBundle,
      ),
    /lacks relevant/,
  );
  assert.equal(
    inspectSemanticRuntimeEvents(
      events(preparedResult, [
        ...preparedMetadata,
        ...sourceReads,
        ...readEvents("published", "app.rs", published.file.bytes),
      ]),
      preparedBundle,
    ).report,
    result.report,
  );
  const textReader = createSemanticSnapshotReader(bundle);
  const toolEvents = (tool: string, args: Record<string, unknown>) => {
    const call = {
      id: `${tool}:${JSON.stringify(args)}`,
      type: "mcp_tool_call",
      server: "portcove_frozen_bundle",
      tool,
      arguments: args,
    };
    return [
      { type: "item.started", item: { ...call, status: "in_progress" } },
      {
        type: "item.completed",
        item: {
          ...call,
          status: "completed",
          error: null,
          result: { content: [{ type: "text", text: JSON.stringify(textReader(tool, args)) }] },
        },
      },
    ];
  };
  const utf8AndDiff = [
    ...toolEvents("read_text", {
      snapshot: "manifest",
      path: "manifest.json",
      offset: 0,
      length: 8192,
    }),
    ...toolEvents("net_diff", { path: "app.rs" }),
  ];
  assert.equal(
    inspectSemanticRuntimeEvents(events(result, utf8AndDiff), bundle).report,
    result.report,
  );
  const forgedText = structuredClone(utf8AndDiff);
  const last = forgedText.at(-1)!;
  assert.ok(
    "result" in last.item &&
      isRecord(last.item.result) &&
      Array.isArray(last.item.result.content) &&
      isRecord(last.item.result.content[0]),
  );
  last.item.result.content[0].text = "{}";
  assert.throws(
    () => inspectSemanticRuntimeEvents(events(result, forgedText), bundle),
    /observation differs/,
  );
  for (const incomplete of [
    metadata,
    [
      ...metadata,
      ...readEvents("baseline", "app.rs", before.file.bytes, 1),
      ...readEvents("source", "app.rs", after.file.bytes, 1),
    ],
    [...metadata, ...readEvents("source", "app.rs", after.file.bytes)],
  ])
    assert.throws(
      () => inspectSemanticRuntimeEvents(events(result, incomplete), bundle),
      /lacks relevant/,
    );
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const split = Math.floor(manifestBytes.length / 2);
  const paged = [
    ...readEvents("manifest", "manifest.json", manifestBytes, split),
    ...readEvents("manifest", "manifest.json", manifestBytes, manifestBytes.length - split, split),
    ...meaningful.slice(2),
  ];
  assert.equal(inspectSemanticRuntimeEvents(events(result, paged), bundle).report, result.report);
  for (const replacement of [
    "",
    "{malformed",
    JSON.stringify({ data: "" }),
    JSON.stringify({
      bytes: 0,
      offset: 0,
      sha256: "0".repeat(64),
      encoding: "base64",
      data: "",
      next: null,
    }),
  ]) {
    const corrupt = {
      ...metadata[1],
      item: { ...metadata[1]!.item, result: { content: [{ type: "text", text: replacement }] } },
    };
    assert.throws(() =>
      inspectSemanticRuntimeEvents(
        events(result, [metadata[0], corrupt, ...meaningful.slice(2)]),
        bundle,
      ),
    );
  }
  assert.throws(() =>
    inspectSemanticRuntimeEvents(events(result, meaningful), {
      ...bundle,
      bundle_sha256: "0".repeat(64),
    }),
  );
  for (const changed of [
    { ...result, bundle_sha256: "b".repeat(64) },
    { ...result, coverage: { ...result.coverage, compatibility: false } },
  ])
    assert.throws(() => inspectSemanticRuntimeEvents(events(changed), bundle));
  for (const outcome of ["refused", "changes-required"])
    assert.equal(
      inspectSemanticRuntimeEvents(
        events({
          ...result,
          outcome,
          coverage: { accumulated_changes: true, classification: false, compatibility: false },
        }),
        bundle,
      ).result.outcome,
      outcome,
    );
  const call = {
    id: "reader-1",
    type: "mcp_tool_call",
    server: "portcove_frozen_bundle",
    tool: "list",
    arguments: { snapshot: "source", offset: 0 },
  };
  const start = { type: "item.started", item: { ...call, status: "in_progress" } };
  const end = {
    type: "item.completed",
    item: { ...call, status: "completed", result: { content: [] }, error: null },
  };
  assert.throws(() => inspectSemanticRuntimeEvents(events(result, [start, end]), bundle));
  const listEnd = {
    ...end,
    item: {
      ...end.item,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: 1, entries: manifest.snapshots.source, next: null }),
          },
        ],
      },
    },
  };
  assert.throws(
    () => inspectSemanticRuntimeEvents(events(result, [start, listEnd]), bundle),
    /lacks relevant/,
  );
  const emptyReads = [
    ...metadata,
    ...readEvents("baseline", "app.rs", before.file.bytes, 1, before.file.bytes.length),
    ...readEvents("source", "app.rs", after.file.bytes, 1, after.file.bytes.length),
  ];
  assert.throws(
    () => inspectSemanticRuntimeEvents(events(result, emptyReads), bundle),
    /lacks relevant/,
  );
  const searchCall = {
    ...call,
    tool: "search",
    arguments: { snapshot: "source", literal: "repaired" },
  };
  const searchEvents = [
    { type: "item.started", item: { ...searchCall, status: "in_progress" } },
    {
      type: "item.completed",
      item: {
        ...searchCall,
        status: "completed",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ matches: [{ path: "app.rs", offset: 12 }], truncated: true }),
            },
          ],
        },
        error: null,
      },
    },
  ];
  assert.throws(
    () => inspectSemanticRuntimeEvents(events(result, [...meaningful, ...searchEvents]), bundle),
    /differs/,
  );

  const fixtureCall = {
    ...call,
    tool: "read",
    arguments: { snapshot: "source", path: "fixture.txt", offset: 0, length: 1024 },
  };
  const fixtureStart = { type: "item.started", item: { ...fixtureCall, status: "in_progress" } };
  const data = Buffer.from("inert fixture\n");
  const fixtureValue = {
    bytes: data.length,
    offset: 0,
    encoding: "base64",
    next: null,
    sha256: createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
  const fixtureEnd = {
    type: "item.completed",
    item: {
      ...fixtureCall,
      status: "completed",
      result: { content: [{ type: "text", text: JSON.stringify(fixtureValue) }] },
      error: null,
    },
  };
  const fixtureInspection = inspectSemanticFixtureEvents(
    events({ fixture: "inert" }, [fixtureStart, fixtureEnd]),
  );
  assert.equal(fixtureInspection.scope, "inert-runtime-reader-fixture");
  assert.throws(
    () =>
      requireDirectSemanticCapture(
        fixtureInspection as unknown as Parameters<typeof requireDirectSemanticCapture>[0],
      ),
    /imported/,
  );
  for (const bad of [
    events({ fixture: "inert" }),
    events({ fixture: "other" }, [fixtureStart, fixtureEnd]),
    events({ fixture: "inert" }, [fixtureStart]),
    events({ fixture: "inert" }, [
      fixtureStart,
      { ...fixtureEnd, item: { ...fixtureEnd.item, result: { content: [] } } },
    ]),
  ])
    assert.throws(() => inspectSemanticFixtureEvents(bad));
  assert.throws(() =>
    inspectSemanticRuntimeEvents(events({ fixture: "inert" }, [fixtureStart, fixtureEnd]), bundle),
  );
  for (const extra of [
    [end],
    [start],
    [start, { ...end, item: { ...end.item, server: "other" } }],
    [start, { ...end, item: { ...end.item, arguments: { snapshot: "source", offset: 1 } } }],
    [start, { ...end, item: { ...end.item, error: { message: "failed" } } }],
    [start, { ...end, item: { ...end.item, result: { content: [], isError: true } } }],
    [start, end, start, end],
    [start, { ...end, item: { ...end.item, result: { data: "x".repeat(65537) } } }],
  ])
    assert.throws(() => inspectSemanticRuntimeEvents(events(result, extra), bundle));
  assert.throws(
    () =>
      inspectSemanticRuntimeEvents(
        events(result, [
          { type: "item.completed", item: { type: "command_execution", command: "candidate.exe" } },
        ]),
        bundle,
      ),
    /unauthorized/,
  );
  assert.throws(() =>
    inspectSemanticRuntimeEvents(Buffer.from('{"type":"thread.started"}'), bundle),
  );
  const imported = {} as Parameters<typeof requireDirectSemanticCapture>[0];
  assert.throws(() => requireDirectSemanticCapture(imported), /imported/);
  let credentials = 0;
  await assert.rejects(
    publishSemanticCapture(
      imported,
      { app_id: 101, installation_id: 303, writer_app_id: 202 },
      {
        requireProvisioningGrant: async () => {},
        authenticateIssuer: async () => {
          credentials++;
          throw new Error("must not release");
        },
      },
    ),
    /imported/,
  );
  assert.equal(credentials, 0);
});

void test("GET-only ambiguous recovery binds detailed issuer/report and refuses changed input, wrong issuer, duplicate or absent effects", () => {
  const opportunity = fixture().opportunity;
  const handoff = prepareSemanticReviewHandoff(opportunity, {
    accepted_opportunity: opportunity,
    completed_at: "2026-01-01T00:00:00Z",
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    report: "Synthetic accepted complete opportunity",
    runtime: "codex-independent-local-review",
    scope: "complete-release-opportunity",
    session_ref: "fixture-only",
  });
  const body = handoff.proposed_request.body;
  const check = {
    ...body,
    id: 7,
    app: { id: 101 },
    output: { ...body.output, annotations_count: 0 },
  };
  const expected = {
    head: body.head_sha,
    external_id: body.external_id,
    summary: body.output.summary,
  };
  let fault = "";
  const api = {
    request(method: string, route: string) {
      assert.equal(method, "GET");
      let value: unknown = check;
      if (route === "repos/boburning/portcove")
        value = { id: 1354613114, full_name: "boburning/portcove", node_id: "fixture-repository" };
      else if (route.includes("/commits/"))
        value = {
          total_count: fault === "missing" ? 0 : fault === "duplicate" ? 2 : 1,
          check_runs:
            fault === "missing"
              ? []
              : fault === "duplicate"
                ? [check, { ...check, id: 8 }]
                : [check],
        };
      else if (fault === "issuer") value = { ...check, app: { id: 202 } };
      else if (fault === "drift") {
        const report: unknown = JSON.parse(body.output.summary);
        assert.ok(typeof report === "object" && report !== null);
        const changed = structuredClone(handoff.evidence);
        const other = prepareSemanticReviewHandoff(opportunity, {
          accepted_opportunity: opportunity,
          completed_at: changed.completed_at,
          coverage: changed.coverage,
          report: "Another valid same-App report",
          runtime: changed.runtime,
          scope: changed.scope,
          session_ref: changed.session_ref,
        });
        value = {
          ...check,
          output: { ...check.output, summary: other.proposed_request.body.output.summary },
        };
      }
      return { status: 200, headers: new Map<string, string>(), body: value };
    },
    graphql() {
      throw new Error("no mutation");
    },
  };
  const config = { app_id: 101, installation_id: 303, writer_app_id: 202 };
  assert.equal(readbackSemanticCheck(api, config, opportunity, expected).check_id, 7);
  for (fault of ["missing", "duplicate", "issuer", "drift"])
    assert.throws(() => readbackSemanticCheck(api, config, opportunity, expected));
  fault = "";
  assert.throws(
    () => readbackSemanticCheck(api, config, { ...opportunity, urgency: true }, expected),
    /exact opportunity/,
  );
});
