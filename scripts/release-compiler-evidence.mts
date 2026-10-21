import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readReleaseCompilerReportArchive } from "./release-compiler-report-archive.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { inspectCompiledCliPackage } from "./release-compiler-outputs.mts";
import { inspectWindowsDesktopCompilerIdentity } from "./release-compiler-desktop.mts";
import { requireVerifiedReleaseCompilerSource } from "./release-compiler-source-admission.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import type { verifyReleasePublicBuildInputs } from "./release-public-build-provenance.mts";
import {
  requirePublicBuildInputProviderBinding,
  requireVerifiedReleasePublicBuildInputs,
} from "./release-public-build-provenance.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectCompilerRiskAssessment706 } from "./linux-beta-risk-706.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";

type Evidence = ReturnType<typeof collectReleaseRunEvidence>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const platforms = ["windows-x86_64", "linux-x86_64"] as const;
const interfaces = ["cli", "desktop"] as const;
type Platform = (typeof platforms)[number];
type Interface = (typeof interfaces)[number];
export interface CompilerPackageIdentity {
  platform_label: string;
  filename: string;
  bytes: number;
  sha256: string;
}
function time(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("compiler observation time unavailable");
  return Date.parse(value);
}
function output(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "bytes,filename,sha256" ||
    typeof raw.filename !== "string" ||
    raw.filename !== path.basename(raw.filename) ||
    /[\\/\r\n\0]/u.test(raw.filename) ||
    typeof raw.bytes !== "number" ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes < 1 ||
    raw.bytes > 512 * 1024 * 1024 ||
    typeof raw.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.sha256)
  )
    throw new Error("compiler output identity is malformed or unbounded");
  return { filename: raw.filename, bytes: raw.bytes, sha256: raw.sha256 };
}
/** Report interpretation alone has no authority. Actual acceptance below also
 * requires provider custody, verified Sigstore subjects and the actual fixed
 * controller source-closure brand, plus every output/package byte binding. */
export function inspectReleaseCompilerReport(
  raw: unknown,
  expected: {
    platform: Platform;
    interface: Interface;
    source_commit: string;
    source_tree: string;
    run_id: string;
    run_attempt: number;
    job: Evidence["jobs"][number];
    public_receipt: unknown;
    input_members: readonly { filename: string; bytes: number; sha256: string }[];
  },
) {
  const nativePath = expected.platform === "windows-x86_64" ? path.win32 : path.posix;
  if (
    !isRecord(raw) ||
    (raw.schema_version !== 2 &&
      !(
        raw.schema_version === 3 &&
        expected.platform === "windows-x86_64" &&
        expected.interface === "desktop"
      )) ||
    raw.authority !== "none" ||
    raw.evidence_scope !== "direct-build-process" ||
    raw.producer_job !== "build" ||
    raw.state !== "completed" ||
    raw.exit_code !== 0 ||
    raw.failure !== null ||
    raw.source_commit !== expected.source_commit ||
    raw.source_tree !== expected.source_tree ||
    raw.run_id !== expected.run_id ||
    raw.run_attempt !== expected.run_attempt ||
    raw.platform !== expected.platform ||
    raw.interface !== expected.interface ||
    typeof raw.capture_module_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.capture_module_sha256) ||
    typeof raw.target_directory !== "string" ||
    !nativePath.isAbsolute(raw.target_directory) ||
    !/[\\/]target[\\/]release-attempt-[A-Za-z0-9]+$/u.test(raw.target_directory) ||
    !isDeepStrictEqual(raw.cargo_resource_policy, {
      jobs: 4,
      incremental: false,
      shared_target_cache: false,
    })
  )
    throw new Error("compiler actual process/source/run/interface/private-target identity differs");
  if (
    !isDeepStrictEqual(raw.public_inputs, expected.public_receipt) ||
    !Array.isArray(raw.input_members) ||
    !isDeepStrictEqual(
      raw.input_members
        .map((entry: unknown) => entry)
        .sort((a: unknown, b: unknown) => {
          if (!isRecord(a) || !isRecord(b)) throw new Error("compiler public input malformed");
          return String(a.filename).localeCompare(String(b.filename));
        }),
      [...expected.input_members].sort((a, b) => a.filename.localeCompare(b.filename)),
    )
  )
    throw new Error(
      "compiler public input use differs from independently reconstructed exact bytes",
    );
  const job = expected.job;
  if (
    job.name !== `Build ${expected.platform}` ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !isRecord(raw.invocation)
  )
    throw new Error("compiler provider job or invocation unavailable");
  const started = time(raw.invocation.started_at),
    finished = time(raw.invocation.finished_at);
  if (started > finished || started < time(job.started_at) || finished > time(job.completed_at))
    throw new Error("compiler invocation is outside the exact producer job lifetime");
  if (
    !isRecord(raw.rust_toolchain) ||
    raw.rust_toolchain.channel !== "1.99.1" ||
    !isRecord(raw.node) ||
    raw.node.version !== `v${controllerNodeVersion}` ||
    !isRecord(raw.tauri) ||
    raw.tauri.version !== "2.12.2" ||
    raw.tauri.native_package !==
      (expected.platform === "windows-x86_64"
        ? "@tauri-apps/cli-win32-x64-msvc"
        : "@tauri-apps/cli-linux-x64-gnu")
  )
    throw new Error("compiler actual pinned toolchain observation unavailable");
  const sourceRoot = nativePath.dirname(nativePath.dirname(raw.target_directory));
  const invocation = raw.invocation;
  if (
    typeof raw.rust_toolchain.cargo !== "string" ||
    !nativePath.isAbsolute(raw.rust_toolchain.cargo) ||
    typeof raw.rust_toolchain.rustc !== "string" ||
    !nativePath.isAbsolute(raw.rust_toolchain.rustc) ||
    typeof raw.rust_toolchain.cargo_version !== "string" ||
    !raw.rust_toolchain.cargo_version.startsWith("cargo 1.99.1 ") ||
    typeof raw.rust_toolchain.rustc_version !== "string" ||
    !raw.rust_toolchain.rustc_version.startsWith("rustc 1.99.1 ") ||
    !Array.isArray(invocation.args)
  )
    throw new Error("compiler actual Rust executable/version probe unavailable");
  if (expected.interface === "cli") {
    if (
      invocation.cwd !== sourceRoot ||
      invocation.executable !== raw.rust_toolchain.cargo ||
      !isDeepStrictEqual(invocation.args, ["build", "--release", "-p", "portcove-cli"])
    )
      throw new Error("compiler CLI actual invocation differs from fixed recipe");
  } else if (
    invocation.cwd !== nativePath.join(sourceRoot, "apps", "desktop") ||
    typeof invocation.executable !== "string" ||
    !nativePath.isAbsolute(invocation.executable) ||
    invocation.args.length !== 7 ||
    typeof invocation.args[0] !== "string" ||
    !nativePath.isAbsolute(invocation.args[0]) ||
    !/[\\/]@tauri-apps[\\/]cli[\\/]tauri\.js$/u.test(invocation.args[0]) ||
    !isDeepStrictEqual(invocation.args.slice(1, 6), [
      "build",
      "--bundles",
      expected.platform === "windows-x86_64" ? "nsis" : "appimage,deb,rpm",
      "--no-sign",
      "--config",
    ]) ||
    typeof invocation.args[6] !== "string" ||
    !nativePath.isAbsolute(invocation.args[6]) ||
    nativePath.basename(invocation.args[6]) !== "tauri.release-public.conf.json"
  )
    throw new Error("compiler desktop actual invocation differs from fixed recipe");
  const toolRoles = [
    "node",
    "tauri-entrypoint",
    "tauri-main",
    "tauri-loader",
    "tauri-native",
    "tauri-manifest",
    "tauri-native-manifest",
    "js-lock",
    "rust-lock",
    "rust-channel",
    "cargo",
    "rustc",
  ].sort();
  if (
    !Array.isArray(raw.tools) ||
    !isDeepStrictEqual(
      raw.tools
        .map((entry: unknown) => {
          if (
            !isRecord(entry) ||
            typeof entry.role !== "string" ||
            typeof entry.bytes !== "number" ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 1 ||
            entry.bytes > 256 * 1024 * 1024 ||
            typeof entry.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
            !isRecord(entry.file_identity)
          )
            throw new Error("compiler actual tool identity unavailable");
          const physical = entry.file_identity;
          if (
            !["dev", "ino", "nlink", "mtime_ms", "ctime_ms"].every(
              (field) =>
                typeof physical[field] === "number" &&
                Number.isFinite(physical[field]) &&
                physical[field] >= 0,
            ) ||
            !Number.isSafeInteger(physical.nlink) ||
            Number(physical.nlink) < 1
          )
            throw new Error("compiler physical tool readback unavailable");
          return entry.role;
        })
        .sort(),
      toolRoles,
    )
  )
    throw new Error("compiler complete actual tool inventory differs");
  if (!Array.isArray(raw.outputs) || raw.outputs.length < 1 || raw.outputs.length > 3)
    throw new Error("compiler complete actual outputs unavailable");
  const outputs = raw.outputs.map(output).sort((a, b) => a.filename.localeCompare(b.filename));
  if (new Set(outputs.map((entry) => entry.filename.toLowerCase())).size !== outputs.length)
    throw new Error("compiler output names duplicate");
  if (
    expected.interface === "cli" &&
    (outputs.length !== 1 ||
      outputs[0]!.filename !==
        (expected.platform === "windows-x86_64" ? "portcove.exe" : "portcove"))
  )
    throw new Error("compiler CLI binary output differs");
  const desktopExecutable =
    raw.schema_version === 3 ? inspectWindowsDesktopCompilerIdentity(raw.desktop_executable) : null;
  if (desktopExecutable && (outputs.length !== 1 || !outputs[0]!.filename.endsWith(".exe")))
    throw new Error("compiler desktop identity lacks its single exact NSIS output slot");
  const observedTools: unknown[] = raw.tools;
  const rustLock = observedTools.find((tool) => isRecord(tool) && tool.role === "rust-lock");
  if (
    Object.hasOwn(raw, "linux_risk_assessment") &&
    (expected.platform !== "linux-x86_64" ||
      expected.interface !== "desktop" ||
      raw.linux_risk_assessment == null)
  )
    throw new Error("compiler scanner subject is missing or attached to another producer slot");
  return {
    authority: "none",
    outputs,
    target_directory: raw.target_directory,
    started,
    finished,
    producer_job_id: job.id,
    desktop_executable: desktopExecutable,
    linux_risk_assessment:
      expected.platform === "linux-x86_64" &&
      expected.interface === "desktop" &&
      raw.linux_risk_assessment != null
        ? inspectCompilerRiskAssessment706(raw.linux_risk_assessment, {
            source_commit: expected.source_commit,
            lock_sha256: isRecord(rustLock) ? String(rustLock.sha256) : "",
            started,
            finished,
          })
        : null,
  };
}

interface VerifiedWindowsDesktopCompilerIdentity {
  executable: ReturnType<typeof inspectWindowsDesktopCompilerIdentity>;
  package: { filename: string; bytes: number; sha256: string };
  source_commit: string;
  source_tree: string;
  run_id: string;
  run_attempt: number;
  producer_job_id: number;
  report_sha256: string;
}
const verifiedCompiler = new WeakMap<
  object,
  {
    files: { filename: string; bytes: number; sha256: string }[];
    source: object;
    sourceTree: string;
    windowsDesktop?: VerifiedWindowsDesktopCompilerIdentity;
    linuxRisk?: ReturnType<typeof inspectCompilerRiskAssessment706>;
  }
>();
export async function requireVerifiedReleaseCompilerEvidence(receipt: object) {
  const retained = verifiedCompiler.get(receipt);
  if (!retained) throw new Error("actual same-process original compiler verification required");
  await requireVerifiedReleaseCompilerSource(retained.source, retained.sourceTree);
  // All retained evidence remains owned by this process. Readback is delegated
  // to the strict regular-file reader rather than accepting serialized receipts.
  const { readControllerToolFile } = await import("./release-controller-tools.mts");
  for (const file of retained.files) {
    const bytes = await readControllerToolFile(file.filename, file.bytes);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("retained compiler proof changed before use");
  }
}

/** Actual attested same-job identity only. Installation/package membership and
 * ordinary updater behavior must still be observed independently. */
export async function requireVerifiedWindowsDesktopCompilerIdentity(receipt: object) {
  await requireVerifiedReleaseCompilerEvidence(receipt);
  const identity = verifiedCompiler.get(receipt)?.windowsDesktop;
  if (!identity) throw new Error("actual attested Windows desktop executable observation required");
  return Object.freeze(structuredClone(identity));
}

/** No serialized report or injected provider can enter this getter. */
export async function requireVerifiedLinuxRiskAssessment706(receipt: object) {
  await requireVerifiedReleaseCompilerEvidence(receipt);
  const retained = verifiedCompiler.get(receipt)?.linuxRisk;
  if (!retained) throw new Error("actual attested same-job Linux scanner assessment required");
  const proof = verifiedCompiler.get(receipt)!;
  const source = await requireVerifiedReleaseCompilerSource(proof.source, proof.sourceTree);
  return { ...structuredClone(retained), source };
}

export async function collectReleaseCompilerEvidence(
  privateRoot: string,
  assembly: unknown,
  evidence: Evidence,
  publicInputs: Awaited<ReturnType<typeof verifyReleasePublicBuildInputs>>,
  cliPackages: ReadonlyMap<string, Buffer>,
  sourceBinding: object,
  options: {
    preparedNamespace: string;
    download?: typeof readGitHubArtifactArchive;
    spawn?: NonNullable<Parameters<typeof verifyReleaseSourceAttestation>[3]>["spawn"];
  } = { preparedNamespace: "" },
) {
  const { accepted } = await inspectTrustedAssemblyInput(assembly);
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    evidence.run.event !== "workflow_dispatch"
  )
    return {
      state: "unknown" as const,
      evidence_scope: "none",
      authority: "none",
      reason: "fixed beta compiler producer is not applicable",
    };
  if (
    evidence.run.revision !== accepted.source_commit ||
    evidence.source_tree !== accepted.source_tree ||
    String(evidence.run.id) !== accepted.run_id ||
    evidence.run.attempt !== accepted.run_attempt ||
    evidence.run.path.split("@")[0] !== ".github/workflows/release.yml" ||
    evidence.run.status !== "completed" ||
    evidence.run.conclusion !== "success"
  )
    throw new Error("compiler provider run/source/attempt differs");
  const request = {
    schema_version: 1,
    repository_id: 1354613114,
    run_id: Number(accepted.run_id),
    attempt: accepted.run_attempt,
    revision: accepted.source_commit,
    tree: accepted.source_tree,
    workflow_sha256: evidence.source_workflow_sha256,
  };
  const runner = createGitHubRunner({
    cwd: privateRoot,
    maxBuffer: 2 * 1024 * 1024,
    timeoutMs: 15000,
  });
  const api = new GitHubApiClient((args, input) =>
    runner([...args, "--hostname", "github.com"], input),
  );
  const freshEvidence = () => collectReleaseRunEvidence(request, { api });
  if (!options.download && !options.spawn) evidence = freshEvidence();
  requirePublicBuildInputProviderBinding(publicInputs.binding, evidence);
  const wanted = platforms.flatMap((platform) =>
    interfaces.map(
      (inter) =>
        `release-compiler-observation-${inter}-${platform}-${accepted.run_id}-${accepted.run_attempt}`,
    ),
  );
  if (wanted.some((name) => !evidence.artifacts.some((artifact) => artifact.name === name)))
    return {
      state: "unknown" as const,
      evidence_scope: "none",
      authority: "none",
      reason: "complete actual compiler report matrix has not been observed",
    };
  const directory = await mkdtemp(path.join(privateRoot, "release-compiler-proof-"));
  const retained: { filename: string; bytes: number; sha256: string }[] = [];
  const subjects: { filename: string; sha256: string }[] = [];
  const observations = [];
  let archiveBytes = 0;
  const retain = async (filename: string, bytes: Buffer) => {
    const absolute = path.join(directory, filename);
    await writeFile(absolute, bytes, { flag: "wx", mode: 0o600 });
    retained.push({ filename: absolute, bytes: bytes.length, sha256: hash(bytes) });
    return absolute;
  };
  for (const platform of platforms) {
    const jobs = evidence.jobs.filter((job) => job.name === `Build ${platform}`);
    if (jobs.length !== 1) throw new Error("compiler producer job identity missing or ambiguous");
    const publicReceipt = publicInputs.receipts.find((receipt) => receipt.platform === platform);
    const publicMembers = publicInputs.compiler_inputs.find((item) => item.platform === platform);
    if (!publicReceipt || !publicMembers)
      throw new Error("independently verified compiler public inputs absent");
    const { platform: _platform, ...expectedPublicReceipt } = publicReceipt;
    const reports = [];
    for (const inter of interfaces) {
      const name = `release-compiler-observation-${inter}-${platform}-${accepted.run_id}-${accepted.run_attempt}`;
      const artifacts = evidence.artifacts.filter((artifact) => artifact.name === name);
      const artifact = artifacts[0]!;
      if (
        artifacts.length !== 1 ||
        artifact.expired ||
        !artifact.archive_sha256 ||
        artifact.bytes < 22 ||
        artifact.bytes > 2 * 1024 * 1024
      )
        throw new Error("compiler immutable report artifact identity/bound differs");
      archiveBytes += artifact.bytes;
      const archive = (options.download ?? readGitHubArtifactArchive)(
        `repos/boburning/portcove/actions/artifacts/${artifact.id}/zip`,
        { cwd: privateRoot, maxBytes: artifact.bytes, timeoutMs: 30000 },
      );
      if (archive.length !== artifact.bytes || hash(archive) !== artifact.archive_sha256)
        throw new Error("compiler report artifact bytes differ");
      await retain(`${artifact.id}.zip`, archive);
      const suffix = `${inter}-${platform}`;
      const { initial, result, files } = readReleaseCompilerReportArchive(archive, platform, inter);
      for (const [name, bytes] of files) await retain(name, bytes);
      const raw: unknown = JSON.parse(result.toString("utf8"));
      const report = inspectReleaseCompilerReport(raw, {
        platform,
        interface: inter,
        source_commit: accepted.source_commit,
        source_tree: accepted.source_tree,
        run_id: accepted.run_id,
        run_attempt: accepted.run_attempt,
        job: jobs[0]!,
        public_receipt: expectedPublicReceipt,
        input_members: publicMembers.members,
      });
      if (
        !initial ||
        !isRecord(raw) ||
        !isRecord(raw.invocation) ||
        !isDeepStrictEqual(JSON.parse(initial.toString("utf8")), {
          ...raw,
          state: "started",
          exit_code: null,
          failure: null,
          outputs: [],
          ...(raw.schema_version === 3 ? { desktop_executable: null } : {}),
          ...(Object.hasOwn(raw, "linux_risk_assessment") ? { linux_risk_assessment: null } : {}),
          invocation: { ...raw.invocation, finished_at: null },
        })
      )
        throw new Error("compiler direct started/completion capture differs");
      reports.push(report);
      subjects.push({ filename: `compiler-result-${suffix}.json`, sha256: hash(result) });
    }
    const [cli, desktop] = reports;
    if (
      !cli ||
      !desktop ||
      cli.target_directory !== desktop.target_directory ||
      cli.finished > desktop.started
    )
      throw new Error("CLI/desktop compiler target or ordered same-job lifetime differs");
    const packages = accepted.files.filter(
      (file) =>
        file.platform_label === platform &&
        !file.filename.startsWith("SHA256SUMS-") &&
        !file.filename.startsWith("release-producer-"),
    );
    const cliPackage = packages.filter((file) => file.filename.startsWith("portcove-cli-"));
    const desktopPackages = packages
      .filter((file) => !file.filename.startsWith("portcove-cli-"))
      .map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 }))
      .sort((a, b) => a.filename.localeCompare(b.filename));
    if (cliPackage.length !== 1 || !isDeepStrictEqual(desktopPackages, desktop.outputs))
      throw new Error("actual desktop compiler outputs differ from complete staged package bytes");
    const packageBytes = cliPackages.get(cliPackage[0]!.filename);
    if (!packageBytes) throw new Error("actual CLI package inner-byte binding unavailable");
    inspectCompiledCliPackage(packageBytes, platform, cliPackage[0]!, cli.outputs[0]!);
    observations.push({ platform, producer_job_id: jobs[0]!.id, cli, desktop });
  }
  const attesters = evidence.jobs.filter((job) => job.name === "attest");
  if (
    attesters.length !== 1 ||
    attesters[0]!.conclusion !== "success" ||
    attesters[0]!.status !== "completed" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(options.preparedNamespace)
  )
    throw new Error("actual compiler report attester or exact prepared namespace unavailable");
  const verified = await verifyReleaseSourceAttestation(
    directory,
    path.join(directory, subjects[0]!.filename),
    {
      source_commit: accepted.source_commit,
      ref: `refs/tags/${options.preparedNamespace}-prepared/v${accepted.version}`,
      run_id: accepted.run_id,
      run_attempt: accepted.run_attempt,
      subjects,
    },
    { ...(options.spawn ? { spawn: options.spawn } : {}) },
  );
  const receipt = Object.freeze({
    state: "verified-compiler-output-bindings",
    evidence_scope:
      options.download ||
      options.spawn ||
      verified.evidence_scope !== "github.com" ||
      publicInputs.evidence_scope !== "github.com"
        ? "injected-provider"
        : "github.com",
    authority: "none",
    directory,
    archive_bytes: archiveBytes,
    source_commit: accepted.source_commit,
    source_tree: accepted.source_tree,
    run_id: accepted.run_id,
    run_attempt: accepted.run_attempt,
    observations,
    attester_job_id: attesters[0]!.id,
    scope:
      "actual fixed compiler invocation/public input use and exact package output bindings; no native/semantic/signing acceptance",
  });
  if (receipt.evidence_scope === "github.com") {
    await requireVerifiedReleasePublicBuildInputs(publicInputs);
    const final = freshEvidence();
    const { observed_at: _before, ...before } = evidence;
    const { observed_at: _after, ...after } = final;
    if (!isDeepStrictEqual(before, after))
      throw new Error("compiler provider identities changed during acquisition");
    await requireVerifiedReleaseCompilerSource(sourceBinding, accepted.source_tree);
    const { readControllerToolFile } = await import("./release-controller-tools.mts");
    const verificationBytes = await readControllerToolFile(
      verified.verification_path,
      4 * 1024 * 1024,
    );
    retained.push({
      filename: verified.verification_path,
      bytes: verificationBytes.length,
      sha256: hash(verificationBytes),
    });
    await retain("provider-evidence.json", Buffer.from(`${JSON.stringify(evidence)}\n`));
    verifiedCompiler.set(receipt, {
      files: retained,
      source: sourceBinding,
      sourceTree: accepted.source_tree,
      ...(() => {
        const linux = observations.find((entry) => entry.platform === "linux-x86_64");
        return linux?.desktop.linux_risk_assessment
          ? { linuxRisk: structuredClone(linux.desktop.linux_risk_assessment) }
          : {};
      })(),
      ...(() => {
        const windows = observations.find((entry) => entry.platform === "windows-x86_64");
        const subject = subjects.find(
          (entry) => entry.filename === "compiler-result-desktop-windows-x86_64.json",
        );
        const executable = windows?.desktop.desktop_executable;
        const packageIdentity = windows?.desktop.outputs[0];
        return executable && subject && packageIdentity
          ? {
              windowsDesktop: structuredClone({
                executable,
                package: packageIdentity,
                source_commit: accepted.source_commit,
                source_tree: accepted.source_tree,
                run_id: accepted.run_id,
                run_attempt: accepted.run_attempt,
                producer_job_id: windows.producer_job_id,
                report_sha256: subject.sha256,
              }),
            }
          : {};
      })(),
    });
  }
  return receipt;
}
