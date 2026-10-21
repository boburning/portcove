/** Installed-parent compiler input custody, separate from hosted admission. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { requireActualPublicJourneySource } from "./release-native-public-pair.mts";
import { readReleaseCompilerReportArchive } from "./release-compiler-report-archive.mts";
import { inspectReleaseCompilerReport } from "./release-compiler-evidence.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import {
  selectPublicBuildInputBinding,
  verifyReleasePublicBuildInputs,
} from "./release-public-build-provenance.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import {
  prepareReleaseCompilerSourceClosure,
  inspectPreparedCompilerSource,
  compareCompilerClosure,
} from "./release-compiler-source.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { remainingNativeParentBudget } from "./release-native-parent.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectWindowsDesktopCompilerIdentity } from "./release-compiler-desktop.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const labels = ["linux-x86_64", "windows-x86_64"] as const;
const interfaces = ["cli", "desktop"] as const;
/** Data-only retained inventory. Its hash must come from an original protected
 * claim; parsing this document never recreates compiler admission. */
export function inspectPublicCompilerRetainedInput(raw: unknown) {
  assert.ok(isRecord(raw));
  assert.deepEqual(Object.keys(raw).sort(), ["files", "identity", "schema_version"]);
  assert.equal(raw.schema_version, 1);
  const identity = raw.identity;
  assert.ok(isRecord(identity) && isRecord(identity.package));
  assert.deepEqual(Object.keys(identity).sort(), [
    "executable",
    "package",
    "producer_job_id",
    "report_sha256",
    "run_attempt",
    "run_id",
    "source_commit",
    "source_tree",
  ]);
  const executable = inspectWindowsDesktopCompilerIdentity(identity.executable);
  assert.deepEqual(Object.keys(identity.package).sort(), ["bytes", "filename", "sha256"]);
  assert.ok(
    typeof identity.package.filename === "string" &&
      /^[A-Za-z0-9._-]+\.exe$/u.test(identity.package.filename),
  );
  assert.ok(
    typeof identity.package.bytes === "number" &&
      Number.isSafeInteger(identity.package.bytes) &&
      identity.package.bytes > 0 &&
      identity.package.bytes <= 512 * 1024 * 1024,
  );
  const hex = (value: unknown, length: number) => {
    assert.ok(typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value));
    return value;
  };
  const positive = (value: unknown) => {
    assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    return value;
  };
  assert.ok(typeof identity.run_id === "string" && /^[1-9][0-9]*$/u.test(identity.run_id));
  assert.ok(Array.isArray(raw.files) && raw.files.length > 0 && raw.files.length <= 64);
  const names = new Set<string>();
  const files = raw.files.map((file: unknown) => {
    assert.ok(isRecord(file));
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "path", "sha256"]);
    assert.ok(
      typeof file.path === "string" &&
        file.path.length <= 256 &&
        /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(file.path) &&
        file.path.split("/").every((part) => part !== "." && part !== ".."),
    );
    const folded = file.path.toLowerCase();
    assert.ok(!names.has(folded));
    names.add(folded);
    assert.ok(
      typeof file.bytes === "number" &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        file.bytes <= 4 * 1024 * 1024,
    );
    assert.ok(typeof file.sha256 === "string" && /^[a-f0-9]{64}$/u.test(file.sha256));
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  return {
    identity: {
      executable,
      package: {
        filename: identity.package.filename,
        bytes: identity.package.bytes,
        sha256: hex(identity.package.sha256, 64),
      },
      source_commit: hex(identity.source_commit, 40),
      source_tree: hex(identity.source_tree, 40),
      run_id: identity.run_id,
      run_attempt: positive(identity.run_attempt),
      producer_job_id: positive(identity.producer_job_id),
      report_sha256: hex(identity.report_sha256, 64),
    },
    files,
  };
}
const proofs = new WeakMap<
  object,
  {
    pair: object;
    slot: "prior" | "candidate" | "parked";
    files: { path: string; bytes: number; sha256: string }[];
    identity: {
      executable: NonNullable<
        ReturnType<typeof inspectReleaseCompilerReport>["desktop_executable"]
      >;
      package: { filename: string; bytes: number; sha256: string };
      source_commit: string;
      source_tree: string;
      run_id: string;
      run_attempt: number;
      producer_job_id: number;
      report_sha256: string;
      retained_input_sha256: string;
    };
  }
>();

/** No caller transport or imported receipt is accepted. Actual local source
 * verification remains explicitly different from a hosted compiler WeakMap. */
export async function collectActualPublicWindowsCompilerIdentity(
  pairReceipt: object,
  slot: "prior" | "candidate",
) {
  assert.ok(slot === "prior" || slot === "candidate");
  const selected = await requireActualPublicJourneySource(pairReceipt);
  if (selected.historical_cohort_receipt && slot === "prior")
    throw new Error("historical public compiler input requires retained admission recovery");
  assert.equal(selected.parent.descriptor.platform_label, "windows-x86_64");
  const config = selected.parent.descriptor.public_journey;
  const git = selected.parent.transport_configuration.windows_tools?.git;
  assert.ok(config && git, "protected public compiler configuration/tool absent");
  const identity = selected.pair[slot];
  const directory = path.join(selected.directory, `compiler-${slot}`);
  await mkdir(directory, { mode: 0o700 });
  const retained: { path: string; bytes: number; sha256: string }[] = [];
  const retain = async (filename: string, bytes: Buffer) => {
    assert.equal(filename, path.basename(filename));
    const file = path.join(directory, filename);
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    retained.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
    return file;
  };
  // Generate from the actual protected installed checkout under its original
  // commit/tree/clean-source guard, using the already appointed Git executable.
  const gitBytes = await readBoundedPublicBuildInputFile(
    path.dirname(git.path),
    path.basename(git.path),
    128 * 1024 * 1024,
  );
  assert.equal(hash(gitBytes), git.sha256);
  const closure = await prepareReleaseCompilerSourceClosure(
    selected.parent.controller_root,
    {
      source_commit: selected.parent.descriptor.controller_revision,
      source_tree: selected.parent.controller_tree,
    },
    { git: git.path },
  );
  await retain("compiler-source-closure.json", Buffer.from(JSON.stringify(closure)));
  inspectPreparedCompilerSource(selected.source.api, identity.allocation);
  await compareCompilerClosure(closure, directory, identity.allocation.source_tree, {
    api: selected.source.api,
  });
  const capture = await readBoundedPublicBuildInputFile(
    selected.parent.controller_root,
    "scripts/release-compiler-capture.mts",
    256 * 1024,
  );
  const captureSha = hash(capture);
  const workflow = await readBoundedPublicBuildInputFile(
    selected.parent.controller_root,
    ".github/workflows/release.yml",
    256 * 1024,
  );
  const request = {
    schema_version: 1 as const,
    repository_id: 1354613114,
    run_id: Number(identity.run_id),
    attempt: identity.run_attempt,
    revision: identity.source_commit,
    tree: identity.source_tree,
    workflow_sha256: hash(workflow),
  };
  const readEvidence = () => collectReleaseRunEvidence(request, { api: selected.source.api });
  const evidence = readEvidence();
  assert.ok(
    evidence.run.event === "workflow_dispatch" &&
      evidence.run.status === "completed" &&
      evidence.run.conclusion === "success",
  );
  const binding = selectPublicBuildInputBinding(config.public_build_inputs, evidence);
  const publicInputs = await verifyReleasePublicBuildInputs(directory, binding, evidence, {
    download: selected.source.download,
  });
  for (const artifact of binding.artifacts) {
    const filename = path.join(publicInputs.directory, `${artifact.platform}.zip`);
    const bytes = await readBoundedPublicBuildInputFile(
      publicInputs.directory,
      path.basename(filename),
      artifact.bytes,
    );
    assert.ok(bytes.length === artifact.bytes && hash(bytes) === artifact.sha256);
    retained.push({ path: filename, bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  const subjects: { filename: string; sha256: string }[] = [];
  let windows: ReturnType<typeof inspectReleaseCompilerReport> | undefined;
  let windowsJob: number | undefined;
  let windowsReportSha: string | undefined;
  for (const platform of labels) {
    const jobs = evidence.jobs.filter((job) => job.name === `Build ${platform}`);
    assert.equal(jobs.length, 1);
    const receipt = publicInputs.receipts.find((entry) => entry.platform === platform);
    const inputs = publicInputs.compiler_inputs.find((entry) => entry.platform === platform);
    assert.ok(receipt && inputs);
    assert.equal(receipt.root_sha256, selected.site.pins.root_sha256);
    assert.equal(receipt.payload_public_key_sha256, identity.package.payload_key_id);
    const { platform: _platform, ...publicReceipt } = receipt;
    const ownReports = [];
    for (const inter of interfaces) {
      const name = `release-compiler-observation-${inter}-${platform}-${identity.run_id}-${identity.run_attempt}`;
      const artifacts = evidence.artifacts.filter((entry) => entry.name === name);
      assert.equal(artifacts.length, 1);
      const artifact = artifacts[0]!;
      assert.ok(
        !artifact.expired &&
          artifact.archive_sha256 &&
          artifact.bytes >= 22 &&
          artifact.bytes <= 2 * 1024 * 1024,
      );
      const archive = selected.source.download(
        `repos/boburning/portcove/actions/artifacts/${artifact.id}/zip`,
        { cwd: directory, maxBytes: artifact.bytes, timeoutMs: remainingNativeParentBudget(30000) },
      );
      assert.ok(archive.length === artifact.bytes && hash(archive) === artifact.archive_sha256);
      await retain(`${artifact.id}.zip`, archive);
      const decoded = readReleaseCompilerReportArchive(archive, platform, inter);
      for (const [filename, bytes] of decoded.files) await retain(filename, bytes);
      const raw: unknown = JSON.parse(decoded.result.toString("utf8"));
      const report = inspectReleaseCompilerReport(raw, {
        platform,
        interface: inter,
        source_commit: identity.source_commit,
        source_tree: identity.source_tree,
        run_id: identity.run_id,
        run_attempt: identity.run_attempt,
        job: jobs[0]!,
        public_receipt: publicReceipt,
        input_members: inputs.members,
      });
      assert.ok(isRecord(raw) && isRecord(raw.invocation));
      assert.equal(raw.capture_module_sha256, captureSha);
      assert.ok(
        isDeepStrictEqual(JSON.parse(decoded.initial.toString("utf8")), {
          ...raw,
          state: "started",
          exit_code: null,
          failure: null,
          outputs: [],
          ...(raw.schema_version === 3 ? { desktop_executable: null } : {}),
          invocation: { ...raw.invocation, finished_at: null },
        }),
      );
      const subject = {
        filename: `compiler-result-${inter}-${platform}.json`,
        sha256: hash(decoded.result),
      };
      subjects.push(subject);
      ownReports.push(report);
      if (platform === "windows-x86_64" && inter === "desktop") {
        assert.equal(
          raw.schema_version,
          3,
          "legacy compiler report cannot appoint installed Windows bytes",
        );
        assert.ok(report.desktop_executable);
        assert.deepEqual(report.outputs, [
          {
            filename: identity.package.filename,
            bytes: identity.package.bytes,
            sha256: identity.package.sha256,
          },
        ]);
        windows = report;
        windowsJob = jobs[0]!.id;
        windowsReportSha = subject.sha256;
      }
    }
    assert.equal(ownReports[0]!.target_directory, ownReports[1]!.target_directory);
    assert.ok(ownReports[0]!.finished <= ownReports[1]!.started);
  }
  const attesters = evidence.jobs.filter((job) => job.name === "attest");
  assert.ok(
    attesters.length === 1 &&
      attesters[0]!.status === "completed" &&
      attesters[0]!.conclusion === "success",
  );
  const ref = `refs/tags/${selected.parent.descriptor.namespace}-prepared/v${identity.version}`;
  const verification = await verifyReleaseSourceAttestation(
    directory,
    path.join(directory, subjects[0]!.filename),
    {
      source_commit: identity.source_commit,
      ref,
      run_id: identity.run_id,
      run_attempt: identity.run_attempt,
      subjects,
    },
    { spawn: selected.source.releaseVerifier({ source_commit: identity.source_commit, ref }) },
  );
  const verifiedBytes = await readBoundedPublicBuildInputFile(
    directory,
    path.basename(verification.verification_path),
    4 * 1024 * 1024,
  );
  retained.push({
    path: verification.verification_path,
    bytes: verifiedBytes.length,
    sha256: hash(verifiedBytes),
  });
  const { observed_at: _before, ...before } = evidence;
  const { observed_at: _after, ...after } = readEvidence();
  assert.ok(
    isDeepStrictEqual(before, after),
    "public compiler provider changed during acquisition",
  );
  await retain("provider-evidence.json", Buffer.from(JSON.stringify(evidence)));
  await requireActualPublicJourneySource(pairReceipt);
  assert.ok(windows?.desktop_executable && windowsJob && windowsReportSha);
  const admittedIdentity = {
    executable: windows.desktop_executable,
    package: {
      filename: identity.package.filename,
      bytes: identity.package.bytes,
      sha256: identity.package.sha256,
    },
    source_commit: identity.source_commit,
    source_tree: identity.source_tree,
    run_id: identity.run_id,
    run_attempt: identity.run_attempt,
    producer_job_id: windowsJob,
    report_sha256: windowsReportSha,
  };
  const manifest = {
    schema_version: 1,
    identity: admittedIdentity,
    files: retained.map((file) => ({
      ...file,
      path: path.relative(directory, file.path).split(path.sep).join("/"),
    })),
  };
  inspectPublicCompilerRetainedInput(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await retain("retained-compiler-input.json", manifestBytes);
  const receipt = Object.freeze({
    kind: "actual-local-public-compiler-input",
    authority: "none",
    scope:
      "retained parent-owned attested executable/package identity; no hosted admission or native acceptance",
  });
  proofs.set(receipt, {
    pair: pairReceipt,
    slot,
    files: retained,
    identity: structuredClone({
      ...admittedIdentity,
      retained_input_sha256: hash(manifestBytes),
    }),
  });
  await requireActualPublicWindowsCompilerIdentity(receipt);
  return receipt;
}

/** Original protected B admission is the authority for these historical local
 * inputs. Current Tough/source is checked separately; expired reports are never
 * downloaded again and a document alone cannot enter this private map. */
export async function recoverActualPublicWindowsCompilerIdentity(
  pairReceipt: object,
  slot: "prior" | "parked",
) {
  assert.ok(slot === "prior" || slot === "parked");
  const selected = await requireActualPublicJourneySource(pairReceipt);
  assert.equal(selected.parent.descriptor.platform_label, "windows-x86_64");
  assert.ok(selected.historical_cohort_receipt && "parked" in selected.pair);
  const { requireActualRetainedPublicCohort } = await import("./release-native-attempt.mts");
  const historical = await requireActualRetainedPublicCohort(selected.historical_cohort_receipt);
  assert.equal(historical.parent_receipt, selected.parent_receipt);
  const proof = historical.parked.marker.request.proof_inputs;
  assert.ok(isRecord(proof) && typeof proof.source_directory === "string");
  const oldSlot = slot === "parked" ? "candidate" : "prior";
  const directory = path.join(
    selected.parent.descriptor.capture_root,
    proof.source_directory,
    `compiler-${oldSlot}`,
  );
  const raw = await readBoundedPublicBuildInputFile(
    directory,
    "retained-compiler-input.json",
    64 * 1024,
  );
  const parsed = inspectPublicCompilerRetainedInput(JSON.parse(raw.toString("utf8")));
  const identity = { ...parsed.identity, retained_input_sha256: hash(raw) };
  assert.equal(
    digest(identity),
    proof[`${oldSlot}_compiler_sha256`],
    "original protected compiler admission differs",
  );
  const receipt = Object.freeze({
    kind: "actual-local-public-compiler-input",
    authority: "none",
    scope:
      "original protected compiler admission retained under current published source; no native acceptance",
  });
  proofs.set(receipt, {
    pair: pairReceipt,
    slot,
    identity,
    files: [
      ...parsed.files.map((file) => ({
        ...file,
        path: path.join(directory, ...file.path.split("/")),
      })),
      {
        path: path.join(directory, "retained-compiler-input.json"),
        bytes: raw.length,
        sha256: hash(raw),
      },
    ],
  });
  await requireActualPublicWindowsCompilerIdentity(receipt);
  return receipt;
}
/** Retained immutable provenance recheck. Current public source/Tough and the
 * original protected parent lifetime are rechecked independently on every use. */
export async function requireActualPublicWindowsCompilerIdentity(receipt: object) {
  const retained = proofs.get(receipt);
  if (!retained) throw new Error("actual local parent compiler input custody required");
  const selected = await requireActualPublicJourneySource(retained.pair);
  const expected =
    retained.slot === "parked"
      ? "parked" in selected.pair
        ? selected.pair.parked
        : undefined
      : selected.pair[retained.slot];
  assert.ok(expected);
  for (const file of retained.files) {
    const bytes = await readBoundedPublicBuildInputFile(
      path.dirname(file.path),
      path.basename(file.path),
      file.bytes,
    );
    assert.ok(
      bytes.length === file.bytes && hash(bytes) === file.sha256,
      "retained public compiler proof changed",
    );
  }
  assert.ok(performance.now() < selected.deadline, "original public parent lifetime exhausted");
  assert.equal(
    digest(retained.identity.package),
    digest({
      filename: expected.package.filename,
      bytes: expected.package.bytes,
      sha256: expected.package.sha256,
    }),
  );
  assert.equal(retained.identity.source_commit, expected.source_commit);
  assert.equal(retained.identity.source_tree, expected.source_tree);
  assert.equal(retained.identity.run_id, expected.run_id);
  assert.equal(retained.identity.run_attempt, expected.run_attempt);
  return {
    identity: structuredClone(retained.identity),
    pair_receipt: retained.pair,
    pair: selected,
    slot: retained.slot,
    authority: "none" as const,
  };
}
