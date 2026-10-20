import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { stageReleaseArtifact, discoverReleaseArtifactFiles } from "./release-artifact-archive.mts";
import { assembleTrustedRelease } from "./trusted-release-assembly.mts";
import { assembleReleaseArtifacts } from "./release-artifact-assembly.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const identity = (bytes: Buffer) => ({ bytes: bytes.length, sha256: hash(bytes) });

void test("opaque transport discards real subprocess output overflow and timeout", () => {
  const endpoint = "repos/boburning/portcove/actions/artifacts/123/zip";
  for (const code of [
    "process.stdout.write(Buffer.alloc(100001))",
    "setInterval(() => {}, 1000)",
  ]) {
    assert.throws(
      () =>
        readGitHubArtifactArchive(endpoint, {
          cwd: process.cwd(),
          maxBytes: 100,
          timeoutMs: 250,
          spawn: (_command, _args, options) => spawnSync(process.execPath, ["-e", code], options),
        }),
      /bounded GitHub artifact transport failed/u,
    );
  }
});

async function fixture(t: test.TestContext) {
  const f = await trustedAssemblyFixture(t);
  const stage = path.join(f.root, "stage");
  await mkdir(stage);
  const platform = f.request.files[0]!.platform_label;
  const entries = f.request.files
    .filter((file) => file.platform_label === platform)
    .map((file) => [file.filename, f.contents.get(`${platform}/${file.filename}`)!] as const);
  return { ...f, stage, platform, entries };
}

void test("provider-byte discovery derives fixed matrix facts while retaining no producer authority", async (t) => {
  const f = await fixture(t);
  const archive = createAuditZip(
    f.entries.map(
      ([name, bytes], i) =>
        [`${i % 2 ? "release-upload/" : ""}${name}`, bytes, { descriptor: true }] as const,
    ),
  );
  const expected = identity(archive);
  const pending = discoverReleaseArtifactFiles(archive, expected, f.platform, f.request);
  archive.fill(0);
  const found = await pending;
  assert.equal(found.authority, "none");
  assert.deepEqual(
    found.files,
    f.request.files.filter((file) => file.platform_label === f.platform),
  );
  assert.equal(found.declared_producer.run_id, "12345");
  assert.equal(found.archive_sha256, expected.sha256);
});

void test("current attempt identity refuses older declared producer bytes in discovery and provider staging", async (t) => {
  const f = await fixture(t);
  const archive = createAuditZip(f.entries);
  const current = { ...f.request, run_attempt: 2 };
  await assert.rejects(
    discoverReleaseArtifactFiles(archive, identity(archive), f.platform, current),
    /producer attempt differs/,
  );
  await assert.rejects(
    stageReleaseArtifact(f.stage, archive, current, f.platform, identity(archive), {
      exactProducerAttempt: true,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      error.cause.message === "release artifact producer attempt differs from artifact identity",
  );
});

void test("discovery refuses changed checksum declarations, producer identity and oversized metadata", async (t) => {
  const f = await fixture(t);
  for (const fault of ["checksum", "producer", "oversized"]) {
    const entries = f.entries.map(
      ([name, bytes]) =>
        [
          name,
          fault === "checksum" && name.startsWith("SHA256SUMS-")
            ? Buffer.from(bytes.toString().replace(/^[a-f0-9]{64}/u, "0".repeat(64)))
            : fault === "producer" && name.startsWith("release-producer-")
              ? Buffer.from(bytes.toString().replace('"12345"', '"54321"'))
              : fault === "oversized" && name.startsWith("release-producer-")
                ? Buffer.alloc(65537, 32)
                : bytes,
        ] as const,
    );
    const archive = createAuditZip(entries);
    await assert.rejects(
      discoverReleaseArtifactFiles(archive, identity(archive), f.platform, f.request),
      fault === "checksum"
        ? /checksum inventory/u
        : fault === "producer"
          ? /another workflow run/u
          : /fixed policy bounds/u,
    );
  }
});

void test("bounded artifact staging accepts both documented layouts and descriptor ZIPs then feeds full assembly", async (t) => {
  const f = await fixture(t);
  for (const platform of new Set(f.request.files.map((file) => file.platform_label))) {
    const archive = createAuditZip(
      f.request.files
        .filter((file) => file.platform_label === platform)
        .map(
          (file, i) =>
            [
              `${i % 2 ? "release-upload/" : ""}${file.filename}`,
              f.contents.get(`${platform}/${file.filename}`)!,
              { descriptor: true, method: i % 2 ? 0 : 8 },
            ] as const,
        ),
    );
    const expected = identity(archive);
    const pending = stageReleaseArtifact(f.stage, archive, f.request, platform, expected);
    // Caller mutation after entry cannot alter retained archive custody.
    archive.fill(0);
    const result = await pending;
    assert.equal(result.authority, "none");
    assert.equal(result.archive_sha256, expected.sha256);
    for (const file of result.files) {
      const bytes = await readFile(path.join(result.directory, file.filename));
      assert.deepEqual(bytes, f.contents.get(`${platform}/${file.filename}`));
    }
  }
  const assembled = await assembleTrustedRelease(f.root, f.stage, f.request);
  assert.equal(assembled.authenticated_assembler, null);
  assert.equal(assembled.release_authorization, "not-evaluated");
  assert.ok(assembled.output_files.length > 1);
});

void test("archive identity, complete inventory and raw metadata refuse before creating stage output", async (t) => {
  const f = await fixture(t);
  const good = createAuditZip(f.entries);
  await assert.rejects(
    stageReleaseArtifact(f.stage, good, f.request, f.platform, {
      ...identity(good),
      sha256: "0".repeat(64),
    }),
    /digest differs/u,
  );
  await assert.rejects(
    stageReleaseArtifact(f.stage, good, f.request, "unknown", identity(good)),
    /unknown/u,
  );
  await assert.rejects(
    stageReleaseArtifact(
      f.stage,
      good,
      { ...f.request, files: f.request.files.slice(1) },
      f.platform,
      identity(good),
    ),
  );
  const bad = [
    createAuditZip(f.entries.slice(1)),
    createAuditZip([...f.entries, [`release-upload/${f.entries[0]![0]}`, f.entries[0]![1]]]),
    createAuditZip([...f.entries.slice(1), ["../escape", "x"]]),
    createAuditZip(
      f.entries.map(([name, bytes], i) => [name, bytes, i ? {} : { attributes: 0xa1ff0000 }]),
    ),
    createAuditZip(
      f.entries.map(([name, bytes], i) => [
        name,
        i ? bytes : Buffer.concat([bytes, Buffer.from("extra")]),
      ]),
    ),
  ];
  const truncated = Buffer.from(good.subarray(0, good.length - 1));
  const zip64 = Buffer.from(good);
  zip64.writeUInt16LE(45, zip64.readUInt32LE(zip64.length - 6) + 6);
  const count = Buffer.from(good);
  count.writeUInt16LE(65535, count.length - 14);
  count.writeUInt16LE(65535, count.length - 12);
  bad.push(truncated, zip64, count);
  for (const archive of bad) {
    await assert.rejects(
      stageReleaseArtifact(f.stage, archive, f.request, f.platform, identity(archive)),
    );
    assert.deepEqual(await readdir(f.stage), []);
  }
});

void test("CRC and independently expected content reject self-consistent changed ZIPs and retain private failure evidence", async (t) => {
  const f = await fixture(t);
  const changed = createAuditZip(
    f.entries.map(([name, bytes], i) => [name, i ? bytes : Buffer.alloc(bytes.length, 120)]),
  );
  await assert.rejects(
    stageReleaseArtifact(f.stage, changed, f.request, f.platform, identity(changed)),
    /retain owned directory/u,
  );
  assert.deepEqual(await readdir(f.stage), [`release-build-${f.platform}`]);
  const directory = path.join(f.stage, `release-build-${f.platform}`);
  await writeFile(path.join(directory, "failure-evidence"), "preserve");
  const archive = createAuditZip(f.entries);
  await assert.rejects(
    stageReleaseArtifact(f.stage, archive, f.request, f.platform, identity(archive)),
    /EEXIST/u,
  );
  assert.equal(await readFile(path.join(directory, "failure-evidence"), "utf8"), "preserve");

  const fresh = path.join(f.root, "crc-stage");
  await mkdir(fresh);
  const crc = createAuditZip(f.entries.map(([name, bytes]) => [name, bytes, { method: 0 }]));
  crc[30 + Buffer.byteLength(f.entries[0]![0])]! ^= 1;
  await assert.rejects(
    stageReleaseArtifact(fresh, crc, f.request, f.platform, identity(crc)),
    /retain owned directory/u,
  );
});

void test("opaque transfer fixes github.com and bounds collection before returning any bytes", () => {
  const endpoint = "repos/boburning/portcove/actions/artifacts/123/zip";
  let calls = 0;
  const opts = { cwd: process.cwd(), maxBytes: 100, timeoutMs: 15000 };
  const bytes = readGitHubArtifactArchive(endpoint, {
    ...opts,
    spawn: (command, args, options) => {
      calls++;
      assert.equal(command, "gh");
      assert.deepEqual(args, ["api", "--hostname", "github.com", endpoint]);
      assert.equal(options.maxBuffer, 100);
      assert.equal(options.timeout, 15000);
      assert.equal(options.encoding, null);
      assert.equal(options.shell, false);
      return { status: 0, stdout: Buffer.alloc(100) };
    },
  });
  assert.equal(bytes.length, 100);
  assert.equal(calls, 1);
  for (const result of [
    { status: 0, stdout: Buffer.alloc(101) },
    { status: 1, stdout: Buffer.alloc(20) },
    {
      status: null,
      stdout: Buffer.alloc(100),
      error: Object.assign(new Error("secret provider output"), { code: "ENOBUFS" }),
    },
    {
      status: null,
      stdout: Buffer.alloc(20),
      error: Object.assign(new Error("secret provider output"), { code: "ETIMEDOUT" }),
    },
  ])
    assert.throws(
      () => readGitHubArtifactArchive(endpoint, { ...opts, spawn: () => result }),
      /^Error: bounded GitHub artifact transport failed$/u,
    );
  for (const route of [
    "https://evil.invalid/zip",
    "repos/boburning/portcove/actions/artifacts/123/zip?token=x",
    "--hostname",
  ])
    assert.throws(() =>
      readGitHubArtifactArchive(route, {
        ...opts,
        spawn: () => {
          assert.fail("invalid route reached transport");
        },
      }),
    );
});

async function integration(t: test.TestContext) {
  const f = await fixture(t);
  const workflow = Buffer.from("inert release workflow fixture; never execute");
  const expected = {
    schema_version: 1 as const,
    repository_id: 1354613114,
    run_id: 12345,
    attempt: 1,
    revision: f.request.source_commit,
    tree: f.request.source_tree,
    workflow_sha256: hash(workflow),
  };
  const blobs = new Map<number, Buffer>();
  const archives = [...new Set(f.request.files.map((file) => file.platform_label))].map(
    (platform, i) => {
      const bytes = createAuditZip(
        f.request.files
          .filter((file) => file.platform_label === platform)
          .map((file) => [
            file.filename,
            f.contents.get(`${platform}/${file.filename}`)!,
            { descriptor: true },
          ]),
      );
      blobs.set(i + 1, bytes);
      return { platform, artifact_id: i + 1, ...identity(bytes) };
    },
  );
  let inventoryReads = 0;
  let drift = false;
  const timestamp = "2026-10-18T00:00:00Z";
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      const key = new URL(endpoint, "https://api.github.com/").pathname.replace(
        "/repos/boburning/portcove",
        "",
      );
      let body: unknown;
      if (key === "/actions/runs/12345" || key === "/actions/runs/12345/attempts/1")
        body = {
          id: 12345,
          run_attempt: 1,
          head_sha: expected.revision,
          repository: { id: expected.repository_id, full_name: "boburning/portcove" },
          head_repository: { id: expected.repository_id },
          path: ".github/workflows/release.yml",
          status: "completed",
          conclusion: "success",
          workflow_id: 6,
          event: "workflow_dispatch",
          updated_at: timestamp,
        };
      else if (key === `/git/commits/${expected.revision}`)
        body = { sha: expected.revision, tree: { sha: expected.tree } };
      else if (key === "/contents/.github/workflows/release.yml")
        body = {
          type: "file",
          path: ".github/workflows/release.yml",
          encoding: "base64",
          size: workflow.length,
          content: workflow.toString("base64"),
        };
      else if (key === "/actions/runs/12345/attempts/1/jobs") body = { total_count: 0, jobs: [] };
      else if (key === "/actions/runs/12345/artifacts") {
        inventoryReads++;
        body = {
          total_count: archives.length,
          artifacts: archives.map((a) => ({
            id: a.artifact_id,
            name: `release-build-${a.platform}-12345-1`,
            size_in_bytes: a.bytes,
            digest: `sha256:${drift && inventoryReads > 1 ? "0".repeat(64) : a.sha256}`,
            expired: false,
            created_at: timestamp,
            expires_at: null,
            workflow_run: {
              id: 12345,
              repository_id: expected.repository_id,
              head_repository_id: expected.repository_id,
              head_sha: expected.revision,
            },
          })),
        };
      } else assert.fail(`unexpected integration endpoint ${key}`);
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  const options = {
    evidence: { api },
    download: (endpoint: string, options: Parameters<typeof readGitHubArtifactArchive>[1]) => {
      const id = Number(endpoint.split("/").at(-2));
      const bytes = blobs.get(id)!;
      assert.equal(options.maxBytes, bytes.length);
      assert.ok(options.timeoutMs <= 120000);
      return bytes;
    },
  };
  return {
    ...f,
    expected,
    archives,
    options,
    setDrift: () => {
      drift = true;
      inventoryReads = 0;
    },
  };
}

void test("complete admitted opaque artifacts stage into a fresh aggregate with before/after provider binding and no invented producer", async (t) => {
  const f = await integration(t);
  const result = await assembleReleaseArtifacts(
    f.stage,
    f.request,
    f.archives,
    f.expected,
    f.options,
  );
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.original_compiler, null);
  assert.equal(result.authenticated_assembler, null);
  assert.equal(result.authority, "none");
  assert.ok(result.aggregate.output_files.length > 1);
  assert.ok(
    result.before_api_evidence.artifacts.every(
      (a) => a.producer_job_id === null && a.producer_attempt === null,
    ),
  );
  const repeat = await assembleReleaseArtifacts(
    f.stage,
    f.request,
    f.archives,
    f.expected,
    f.options,
  );
  assert.notEqual(repeat.directory, result.directory);
  assert.deepEqual(repeat.aggregate.output_files, result.aggregate.output_files);
  f.setDrift();
  await assert.rejects(
    assembleReleaseArtifacts(f.stage, f.request, f.archives, f.expected, f.options),
    /retain owned directory/u,
  );
  const roots = await readdir(f.stage);
  assert.equal(roots.length, 3);
  const partial = roots.find(
    (root) => ![path.basename(result.directory), path.basename(repeat.directory)].includes(root),
  )!;
  assert.deepEqual(await readdir(path.join(f.stage, partial)), ["inputs"]);
  assert.ok(
    (await readdir(path.join(f.stage, partial, "inputs"))).every((name) =>
      name.startsWith("release-build-"),
    ),
  );
});

void test("artifact matrix and run mismatch refuse before transport or private output", async (t) => {
  const f = await integration(t);
  const options = {
    ...f.options,
    download: () => {
      assert.fail("invalid admission reached download");
    },
  };
  for (const archives of [
    f.archives.slice(1),
    f.archives.map((a) => ({ ...a, artifact_id: 1 })),
    f.archives.map((a) => ({ ...a, sha256: "0".repeat(64) })),
  ])
    await assert.rejects(
      assembleReleaseArtifacts(f.stage, f.request, archives, f.expected, options),
    );
  await assert.rejects(
    assembleReleaseArtifacts(
      f.stage,
      f.request,
      f.archives,
      { ...f.expected, attempt: 2 },
      options,
    ),
  );
  assert.deepEqual(await readdir(f.stage), []);
});
