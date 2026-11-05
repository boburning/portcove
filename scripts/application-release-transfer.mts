/** Provider artifact transfer for the application package job. No candidate code
 * is loaded, and neither an artifact nor its provenance grants release authority. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { isRecord } from "./runtime-values.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  applicationPackageNames,
  inspectApplicationPackageBytes,
} from "./application-release-artifacts.mts";
import type { ApplicationPackageExpectation } from "./application-release-artifacts.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import {
  inspectApplicationReleaseExecution,
  inspectApplicationPackageExecution,
} from "./application-release-policy.mts";

export function inspectApplicationPackageArtifact(
  raw: unknown,
  expected: {
    artifact: number;
    control_commit: string;
    run_id: string;
    provenance_attempt: number;
  },
  phase: "compiler" | "unsigned" = "unsigned",
) {
  assert.ok(Number.isSafeInteger(expected.artifact) && expected.artifact > 0);
  assert.match(expected.control_commit, /^[a-f0-9]{40}$/u);
  assert.match(expected.run_id, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(expected.run_id)));
  assert.ok(
    Number.isSafeInteger(expected.provenance_attempt) &&
      expected.provenance_attempt >= 1 &&
      expected.provenance_attempt <= 3,
  );
  assert.ok(isRecord(raw));
  assert.equal(raw.id, expected.artifact);
  assert.ok(phase === "compiler" || phase === "unsigned");
  assert.equal(raw.name, `application-${phase}-${expected.run_id}-${expected.provenance_attempt}`);
  assert.equal(raw.expired, false);
  assert.ok(
    Number.isSafeInteger(raw.size_in_bytes) &&
      Number(raw.size_in_bytes) >= 22 &&
      Number(raw.size_in_bytes) <= 512 * 1024 ** 2,
  );
  assert.ok(typeof raw.digest === "string");
  assert.match(raw.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(isRecord(raw.workflow_run));
  assert.equal(raw.workflow_run.id, Number(expected.run_id));
  assert.equal(raw.workflow_run.head_sha, expected.control_commit);
  assert.equal(raw.workflow_run.repository_id, 1354613114);
  return { bytes: Number(raw.size_in_bytes), sha256: raw.digest.slice(7) };
}

async function receivePackageArchive(
  directory: string,
  expected: ApplicationPackageExpectation & { artifact: number; provenance_attempt: number },
  phase: "compiler" | "unsigned",
) {
  expected = structuredClone(expected);
  applicationPackageNames(expected.version);
  const endpoint = `repos/boburning/portcove/actions/artifacts/${expected.artifact}`;
  const raw: unknown = JSON.parse(
    execFileSync("gh", ["api", "--hostname", "github.com", endpoint], {
      env: readOnlyReleaseChildEnvironment(),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 65536,
    }),
  );
  const identity = inspectApplicationPackageArtifact(raw, expected, phase);
  const archive = readGitHubArtifactArchive(`${endpoint}/zip`, {
    cwd: process.cwd(),
    maxBytes: 512 * 1024 ** 2,
    timeoutMs: 120000,
  });
  assert.equal(archive.length, identity.bytes);
  assert.equal(createHash("sha256").update(archive).digest("hex"), identity.sha256);
  await extractApplicationPackageArchive(archive, directory, expected.version, phase);
  return identity;
}

export async function extractApplicationPackageArchive(
  archive: Buffer,
  directory: string,
  version: string,
  phase: "compiler" | "unsigned",
) {
  assert.ok(phase === "compiler" || phase === "unsigned");
  const names = [
    ...applicationPackageNames(version),
    ...(phase === "unsigned" ? ["application-release.json"] : []),
  ];
  const parsed = inspectBoundedZip(
    archive,
    {
      compressedBytes: 512 * 1024 ** 2,
      expandedBytes: 2 * 1024 ** 3,
      files: names.length,
      nameBytes: 160,
      allowedPaths: new Set(names),
    },
    { deadline: Date.now() + 30000 },
  );
  assert.equal(parsed.entries.length, names.length);
  for (const entry of parsed.entries) {
    const maximum = entry.name.endsWith(".json") ? 16 * 1024 ** 2 : 512 * 1024 ** 2;
    assert.ok(entry.bytes > 0 && entry.bytes <= maximum);
  }
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false });
  for (const entry of parsed.entries) {
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    assert.equal(bytes.length, entry.bytes);
    assert.equal(crc32(bytes), entry.crc);
    await writeFile(path.join(directory, entry.name), bytes, { flag: "wx", mode: 0o600 });
  }
}

export async function receiveApplicationPackages(
  directory: string,
  expected: ApplicationPackageExpectation & { artifact: number; provenance_attempt: number },
) {
  expected = structuredClone(expected);
  const execution = inspectApplicationReleaseExecution(process.env);
  assert.equal(expected.control_commit, execution.source);
  assert.equal(expected.control_ref, execution.ref);
  assert.equal(expected.run_id, execution.run_id);
  assert.ok(
    expected.provenance_attempt <= execution.run_attempt &&
      expected.package_attempt <= expected.provenance_attempt,
  );
  const identity = await receivePackageArchive(directory, expected, "unsigned");
  const binding: ApplicationPackageExpectation = {
    source_commit: expected.source_commit,
    source_tree: expected.source_tree,
    version: expected.version,
    control_commit: expected.control_commit,
    control_ref: expected.control_ref,
    run_id: expected.run_id,
    package_attempt: expected.package_attempt,
  };
  const manifest = await inspectApplicationPackageBytes(directory, binding);
  const bytes = await readBoundedPublicBuildInputFile(directory, "application-release.json", 65536);
  assert.deepEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), manifest);
  const verification = await verifyReleaseSourceAttestation(
    directory,
    "application-release.json",
    {
      source_commit: expected.control_commit,
      ref: expected.control_ref,
      run_id: expected.run_id,
      run_attempt: expected.provenance_attempt,
      subjects: [
        ...manifest.files,
        {
          filename: "application-release.json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    },
    { scope: "application-package" },
  );
  return {
    manifest,
    verification,
    artifact: { id: expected.artifact, ...identity },
    authority: "none",
  };
}

/** The original compiler is unauthenticated candidate execution. Transfer data
 * within its fixed provider/run bounds before the fresh attester constructs
 * and signs a manifest. No downloaded file is ever imported or executed. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], "compiler");
  const execution = inspectApplicationPackageExecution(process.env);
  const attempt = Number(process.env.PORTCOVE_PACKAGE_ATTEMPT);
  assert.ok(attempt <= execution.run_attempt);
  await receivePackageArchive(
    path.resolve("work/application-unsigned"),
    {
      artifact: Number(process.env.PORTCOVE_COMPILER_ARTIFACT),
      provenance_attempt: attempt,
      package_attempt: attempt,
      source_commit: process.env.PORTCOVE_PRODUCT_SOURCE ?? "",
      source_tree: process.env.PORTCOVE_PRODUCT_TREE ?? "",
      version: process.env.PORTCOVE_PRODUCT_VERSION ?? "",
      control_commit: execution.source,
      control_ref: execution.ref,
      run_id: execution.run_id,
    },
    "compiler",
  );
}
