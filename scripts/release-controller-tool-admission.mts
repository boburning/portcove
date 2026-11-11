import { fixedReleaseToolDependencies } from "./release-tool-dependency-selection.mts";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import type { ReleaseArtifactMetadataProvider } from "./release-custody-provider.mts";
import type { RetainedGitHubSpawn } from "./github-cli.mts";
import type { SigningArchiveDownload } from "./release-signing-handoff.mts";
import { verifyControllerArtifactStatement } from "./github-controller-attestation.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { isRecord } from "./runtime-values.mts";
import { GitHubApiError } from "./github-operation.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  controllerToolPredicateType,
  windowsControllerToolPredicateType,
  controllerToolPlatformProfile,
  controllerToolEntries,
  controllerToolZipMaximumBytes,
  inspectControllerToolArchive,
  inspectControllerToolManifest,
  readControllerToolFile,
} from "./release-controller-tools.mts";
import {
  requestAssemblerToken,
  jobIdentityRefusalCode,
  verifyControllerToolBootstrapJobIdentity,
  inspectAssemblerIdentityExpectation,
  controllerToolBootstrapProfile,
} from "./assembler-job-identity.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const repository = "boburning/portcove";
const base = `repos/${repository}`;
export interface ControllerToolArtifactExpected {
  platform?: "windows-x86_64";
  controller_revision: string;
  source_tree: string;
  controller_ref: string;
  run_id: string;
  run_attempt: number;
  artifact_id: number;
  sha256: string;
}
function expectedInput(raw: ControllerToolArtifactExpected) {
  const expected = structuredClone(raw);
  const selected = Object.hasOwn(expected, "platform");
  if (
    Object.keys(expected).sort().join(",") !==
      (selected
        ? "artifact_id,controller_ref,controller_revision,platform,run_attempt,run_id,sha256,source_tree"
        : "artifact_id,controller_ref,controller_revision,run_attempt,run_id,sha256,source_tree") ||
    (selected && expected.platform !== "windows-x86_64") ||
    !/^[a-f0-9]{40}$/.test(expected.controller_revision) ||
    !/^[a-f0-9]{40}$/.test(expected.source_tree) ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
      expected.controller_ref,
    ) ||
    !/^[1-9][0-9]{0,15}$/.test(expected.run_id) ||
    expected.run_attempt !== 1 ||
    !Number.isSafeInteger(expected.artifact_id) ||
    expected.artifact_id < 1 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  )
    throw new Error("exact fixed controller tool artifact identity required");
  return expected;
}
function toolProfile(expected: ControllerToolArtifactExpected) {
  const platform = expected.platform ?? "linux-x86_64";
  const windows = platform === "windows-x86_64";
  return {
    ...controllerToolPlatformProfile(platform),
    ...controllerToolBootstrapProfile(platform),
    artifact: windows ? "trusted-controller-tools-windows" : "trusted-controller-tools",
    bundle_member: windows
      ? "controller-tools-windows-attestation.json"
      : "controller-tools-attestation.json",
    predicate_type: windows ? windowsControllerToolPredicateType : controllerToolPredicateType,
    subject: windows ? "controller-tools-windows-manifest" : "controller-tools-manifest",
  };
}
function predicateProfile(expected: ControllerToolArtifactExpected) {
  return expected.platform === "windows-x86_64"
    ? { schema_version: 2, platform: "windows-x86_64" }
    : { schema_version: 1 };
}
function artifact(
  raw: unknown,
  expected: ControllerToolArtifactExpected,
  id: number,
  sha256: string,
  bundle = false,
) {
  const profile = toolProfile(expected);
  if (
    !isRecord(raw) ||
    raw.id !== id ||
    raw.name !==
      `${profile.artifact}${bundle ? "-attestation" : ""}-${expected.run_id}-${expected.run_attempt}` ||
    raw.expired !== false ||
    raw.digest !== `sha256:${sha256}` ||
    typeof raw.size_in_bytes !== "number" ||
    !Number.isSafeInteger(raw.size_in_bytes) ||
    raw.size_in_bytes < 22 ||
    raw.size_in_bytes > (bundle ? 1024 ** 2 : controllerToolZipMaximumBytes) ||
    !isRecord(raw.workflow_run) ||
    raw.workflow_run.id !== Number(expected.run_id) ||
    raw.workflow_run.repository_id !== 1354613114 ||
    raw.workflow_run.head_repository_id !== 1354613114 ||
    raw.workflow_run.head_sha !== expected.controller_revision
  )
    throw new Error("controller tool artifact provider identity differs");
  return { id, bytes: raw.size_in_bytes, sha256 };
}
function runIdentity(raw: unknown, expected: ControllerToolArtifactExpected) {
  if (
    !isRecord(raw) ||
    raw.id !== Number(expected.run_id) ||
    raw.run_attempt !== expected.run_attempt ||
    raw.head_sha !== expected.controller_revision ||
    raw.path !== productionControllerWorkflow ||
    raw.event !== "workflow_dispatch" ||
    !["in_progress", "completed"].includes(String(raw.status)) ||
    (raw.conclusion !== null && raw.conclusion !== "success") ||
    !isRecord(raw.repository) ||
    raw.repository.id !== 1354613114 ||
    raw.repository.full_name !== repository ||
    !isRecord(raw.head_repository) ||
    raw.head_repository.id !== 1354613114
  )
    throw new Error("controller tool run/source/attempt differs");
  return { id: raw.id, attempt: raw.run_attempt, source: raw.head_sha };
}
const receivedTools = new WeakMap<
  object,
  {
    tools: string;
    files: { path: string; bytes: number; sha256: string }[];
    manifest_sha256: string;
    scope: string;
    expected: ControllerToolArtifactExpected;
  }
>();
/** Same-process use only. Imported receipts and injected providers cannot choose
 * executable tools. Rehash the entire fixed inventory immediately before use. */
export async function verifiedControllerToolPaths(receipt: object) {
  const retained = receivedTools.get(receipt);
  if (!retained || retained.scope !== "github.com")
    throw new Error("actual same-process controller tool verification required");
  const profile = toolProfile(retained.expected);
  for (const file of retained.files) {
    const bytes = await readControllerToolFile(path.join(retained.tools, file.path), file.bytes);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("verified controller tool changed before use");
  }
  const manifestBytes = await readControllerToolFile(
    path.join(retained.tools, "manifest.json"),
    65536,
  );
  if (hash(manifestBytes) !== retained.manifest_sha256)
    throw new Error("verified tool manifest changed");
  const manifest = inspectControllerToolManifest(
    JSON.parse(manifestBytes.toString("utf8")),
    profile.platform,
  );
  return Object.freeze({
    identity: Object.freeze(structuredClone(retained.expected)),
    platform: profile.platform,
    tauri_cli_version: manifest.tauri_cli_version,
    root: retained.tools,
    node: path.join(retained.tools, `bin/node${profile.suffix}`),
    cli: path.join(retained.tools, `bin/portcove${profile.suffix}`),
    rust: path.join(retained.tools, `bin/portcove-release-tools${profile.suffix}`),
    tauriAddon: path.join(retained.tools, "bin/tauri-addon.node"),
    nativeDriver: path.join(retained.tools, `bin/tauri-driver${profile.suffix}`),
    pnpm: path.join(retained.tools, `bin/pnpm${profile.suffix}`),
    ...(profile.platform === "windows-x86_64"
      ? { webviewDriver: path.join(retained.tools, "bin/msedgedriver.exe") }
      : {}),
    publicAssets: path.join(retained.tools, "release"),
    compiler_source_closure: path.join(retained.tools, "compiler-source-closure.json"),
    entries: Object.freeze(
      Object.fromEntries(
        controllerToolEntries.map((name) => [
          name,
          path.join(retained.tools, "scripts", `${name}.bundle.mjs`),
        ]),
      ),
    ),
  });
}
/** The producer's raw JWT is consumed only in this process and never retained.
 * The existing attestation action signs this public predicate and exact manifest. */
export async function prepareControllerToolPredicate(
  root: string,
  raw: ControllerToolArtifactExpected,
  rawIdentity: unknown,
) {
  const environment = { ...process.env };
  const token = environment.GH_TOKEN ?? "";
  const credential = { kind: "explicit", token } as const;
  const inheritedDeadline = coordinatorCommandDeadline() ?? Infinity;
  const deadline = (maximum: number) => Math.min(inheritedDeadline, performance.now() + maximum);
  const directFetch: typeof globalThis.fetch = (input, init) => {
    assertTrustedDirectNode("controller tool sender");
    return globalThis.fetch(input, init);
  };
  const expected = expectedInput(raw);
  const profile = toolProfile(expected);
  const identityExpected = inspectAssemblerIdentityExpectation(structuredClone(rawIdentity));
  if (
    identityExpected.audience !== profile.audience ||
    identityExpected.controller_revision !== expected.controller_revision ||
    identityExpected.controller_ref !== expected.controller_ref ||
    identityExpected.run_id !== expected.run_id ||
    identityExpected.run_attempt !== expected.run_attempt
  )
    throw new Error("bootstrap identity expectations differ from the fixed upload");
  const attempt = await mkdtemp(path.join(root, "controller-tool-binding-"));
  await writeFile(path.join(attempt, "expected.json"), JSON.stringify(expected), {
    flag: "wx",
    mode: 0o600,
  });
  let phase = "provider-before";
  try {
    const { createReleaseCustodyProvider } = await import("./release-custody-provider.mts");
    const read = async () => {
      const metadata = await createReleaseCustodyProvider({
        token,
        deadline: deadline(15000),
        maxBytes: 128 * 1024,
        fetch: directFetch,
      });
      const data = await metadata.artifact(expected.artifact_id);
      return artifact(data, expected, expected.artifact_id, expected.sha256);
    };
    const before = await read();
    await writeFile(path.join(attempt, "provider-before.json"), JSON.stringify(before), {
      flag: "wx",
      mode: 0o600,
    });
    phase = "opaque-upload-readback";
    const { downloadGitHubArtifactArchiveFile } = await import("./github-artifact-download.mts");
    const archivePath = path.join(attempt, "uploaded.zip");
    const archiveDeadline = deadline(120000);
    await downloadGitHubArtifactArchiveFile(
      `${base}/actions/artifacts/${before.id}/zip`,
      archivePath,
      {
        credential,
        deadline: archiveDeadline,
        maxBytes: before.bytes,
        fetch: directFetch,
      },
    );
    const archive = await readControllerToolFile(archivePath, before.bytes);
    if (
      performance.now() >= archiveDeadline ||
      archive.length !== before.bytes ||
      hash(archive) !== before.sha256
    )
      throw new Error("bootstrap upload ZIP changed or exceeded its bound");
    const inspected = inspectControllerToolArchive(archive, {
      dependencies: fixedReleaseToolDependencies(),
      source_commit: expected.controller_revision,
      source_tree: expected.source_tree,
      platform: profile.platform,
    });
    phase = "producer-token-request";
    const oidc = await requestAssemblerToken(
      identityExpected.audience,
      environment,
      globalThis.fetch,
      deadline(15000),
    );
    phase = "producer-identity-verification";
    const identity = await verifyControllerToolBootstrapJobIdentity(
      oidc,
      identityExpected,
      {
        transport: { sdkToken: token, deadline: deadline(120000) },
      },
      profile.platform,
    );
    phase = "producer-upload-identity-recheck";
    if (
      identity.evidence_scope !== "github.com" ||
      Date.now() >= Date.parse(identity.expires_at) ||
      JSON.stringify(before) !== JSON.stringify(await read()) ||
      Date.now() >= Date.parse(identity.expires_at)
    )
      throw new Error("bootstrap identity/upload drifted");
    phase = "producer-predicate-output";
    const predicate = {
      ...predicateProfile(expected),
      role: "fixed-controller-tools",
      repository,
      repository_id: 1354613114,
      controller: {
        revision: expected.controller_revision,
        tree: expected.source_tree,
        ref: expected.controller_ref,
        workflow: productionControllerWorkflow,
      },
      producer: {
        run_id: expected.run_id,
        run_attempt: expected.run_attempt,
        job_id: identity.job_id,
        check_run_id: identity.check_run_id,
      },
      artifact: before,
      manifest_sha256: inspected.manifest_sha256,
      manifest: inspected.manifest,
      compile_acceptance: "not-established",
      authority: "none",
    };
    const bytes = JSON.stringify(predicate);
    if (Buffer.byteLength(bytes) > 65536) throw new Error("bootstrap predicate exceeds bound");
    await writeFile(
      path.join(
        root,
        `${profile.platform === "windows-x86_64" ? "controller-tools-windows" : "controller-tools"}-predicate.json`,
      ),
      bytes,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await writeFile(
      path.join(
        root,
        `${profile.platform === "windows-x86_64" ? "controller-tools-windows" : "controller-tools"}-manifest.json`,
      ),
      inspected.files.get("manifest.json")!,
      { flag: "wx", mode: 0o600 },
    );
    return {
      predicate,
      predicate_type: profile.predicate_type,
      subject_name: profile.subject,
      manifest_sha256: inspected.manifest_sha256,
      directory: attempt,
      authority: "none",
    };
  } catch (error) {
    const identityRefusal = jobIdentityRefusalCode(error);
    await writeFile(
      path.join(attempt, "refusal.json"),
      JSON.stringify({
        directory: attempt,
        phase,
        ...(identityRefusal ? { identity_refusal: identityRefusal } : {}),
        ...(error instanceof GitHubApiError && error.status
          ? { provider_status: error.status }
          : {}),
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`controller tool binding refused; retain ${attempt}`);
  }
}

/** Independently pinned gh/Sigstore verification survives producer completion
 * without retaining a bearer or ignoring token expiry. All tools are opaque
 * bytes until the complete archive, signed manifest and provider bracket agree. */
export async function receiveControllerTools(
  parent: string,
  raw: ControllerToolArtifactExpected,
  rawBundle: { artifact_id: number; sha256: string },
  options: {
    metadata?: ReleaseArtifactMetadataProvider;
    download?: SigningArchiveDownload;
    spawn?: RetainedGitHubSpawn;
    fetch?: typeof globalThis.fetch;
    deadline?: number;
  } = {},
) {
  const { metadata: injectedMetadata, download: injectedDownload, spawn, fetch } = options;
  const { deadline: requestedDeadline } = options;
  if (
    requestedDeadline !== undefined &&
    (!Number.isFinite(requestedDeadline) ||
      Math.floor(requestedDeadline - performance.now()) > 600000)
  )
    throw new Error("controller tool receiver phase deadline exhausted");
  const inherited = coordinatorCommandDeadline();
  const deadline =
    inherited === undefined
      ? requestedDeadline
      : Math.min(inherited, requestedDeadline ?? Infinity);
  const { PATH, SystemRoot, GH_TOKEN } = process.env;
  const token = GH_TOKEN ?? "";
  const directFetch: typeof globalThis.fetch = (input, init) => {
    assertTrustedDirectNode("controller tool receiver");
    return (fetch ?? globalThis.fetch)(input, init);
  };
  const remaining = (maximum: number) => {
    const left = deadline === undefined ? maximum : Math.floor(deadline - performance.now());
    if (!Number.isFinite(left) || left < 1 || (deadline !== undefined && left > 600000))
      throw new Error("controller tool receiver phase deadline exhausted");
    return Math.min(maximum, left);
  };
  remaining(15000);
  const expected = expectedInput(raw),
    bundle = structuredClone(rawBundle);
  const profile = toolProfile(expected);
  if (
    Object.keys(bundle).sort().join(",") !== "artifact_id,sha256" ||
    !Number.isSafeInteger(bundle.artifact_id) ||
    bundle.artifact_id < 1 ||
    bundle.artifact_id === expected.artifact_id ||
    !/^[a-f0-9]{64}$/.test(bundle.sha256)
  )
    throw new Error("independent bootstrap attestation bundle identity required");
  const directory = await mkdtemp(
    path.join(parent, profile.platform === "windows-x86_64" ? "ctr-" : "controller-tool-receiver-"),
  );
  let phase = "provider-before";
  try {
    const home = path.join(directory, "reader-home");
    await mkdir(home, { mode: 0o700 });
    const environment = {
      PATH,
      SystemRoot,
      HOME: home,
      USERPROFILE: home,
      TEMP: home,
      TMP: home,
      TMPDIR: home,
      GH_CONFIG_DIR: path.join(home, "gh"),
      GH_HOST: "github.com",
      GH_TOKEN,
    };
    let provider = injectedMetadata;
    if (!provider) {
      const { createReleaseCustodyProvider } = await import("./release-custody-provider.mts");
      provider = await createReleaseCustodyProvider({
        token,
        deadline: deadline ?? performance.now() + 600000,
        maxBytes: 128 * 1024,
        fetch: directFetch,
      });
    }
    const metadata = provider;
    let requests = 0;
    const get = async (read: () => Promise<unknown>) => {
      remaining(15000);
      if (++requests > 12) throw new Error("bootstrap provider request bound exhausted");
      const body = await read();
      remaining(15000);
      if (Buffer.byteLength(JSON.stringify(body)) > 128 * 1024)
        throw new Error("bootstrap provider unavailable");
      return body;
    };
    const sourceIdentity = async () => {
      const commit = await get(() => metadata.commit(expected.controller_revision));
      if (
        !isRecord(commit) ||
        commit.sha !== expected.controller_revision ||
        !isRecord(commit.tree) ||
        commit.tree.sha !== expected.source_tree
      )
        throw new Error("bootstrap source tree differs from provider commit");
      return { commit: commit.sha, tree: commit.tree.sha };
    };
    const snapshot = async () => ({
      source: await sourceIdentity(),
      run: runIdentity(await get(() => metadata.run(expected.run_id)), expected),
      attempt: runIdentity(
        await get(() => metadata.attempt(expected.run_id, expected.run_attempt)),
        expected,
      ),
      tools: artifact(
        await get(() => metadata.artifact(expected.artifact_id)),
        expected,
        expected.artifact_id,
        expected.sha256,
      ),
      bundle: artifact(
        await get(() => metadata.artifact(bundle.artifact_id)),
        expected,
        bundle.artifact_id,
        bundle.sha256,
        true,
      ),
    });
    const before = await snapshot();
    await writeFile(path.join(directory, "provider-before.json"), JSON.stringify(before), {
      flag: "wx",
      mode: 0o600,
    });
    const download = async (item: { id: number; bytes: number; sha256: string }) => {
      const endpoint = `${base}/actions/artifacts/${item.id}/zip`;
      const transferDeadline = performance.now() + remaining(120000);
      let bytes;
      if (injectedDownload) {
        bytes = await injectedDownload(endpoint, {
          cwd: directory,
          maxBytes: item.bytes,
          timeoutMs: remaining(120000),
        });
      } else {
        const { downloadGitHubArtifactArchiveFile } =
          await import("./github-artifact-download.mts");
        const scratch = path.join(directory, `archive-${item.id}.zip`);
        await downloadGitHubArtifactArchiveFile(endpoint, scratch, {
          credential: { kind: "explicit", token },
          deadline: transferDeadline,
          maxBytes: item.bytes,
          fetch: directFetch,
        });
        try {
          remaining(120000);
          bytes = await readControllerToolFile(scratch, item.bytes);
        } finally {
          await unlink(scratch);
        }
      }
      remaining(120000);
      if (
        performance.now() >= transferDeadline ||
        bytes.length !== item.bytes ||
        hash(bytes) !== item.sha256
      )
        throw new Error("bootstrap opaque archive differs or exceeded its bound");
      return Buffer.from(bytes);
    };
    phase = "opaque-download";
    const archive = await download(before.tools),
      bundleArchive = await download(before.bundle);
    await writeFile(path.join(directory, "tools.zip"), archive, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(directory, "bundle.zip"), bundleArchive, { flag: "wx", mode: 0o600 });
    const inspected = inspectControllerToolArchive(archive, {
      dependencies: fixedReleaseToolDependencies(),
      source_commit: expected.controller_revision,
      source_tree: expected.source_tree,
      platform: profile.platform,
    });
    const entries = inspectBoundedZip(bundleArchive, {
      compressedBytes: 1024 ** 2,
      expandedBytes: 512 * 1024,
      files: 1,
      nameBytes: 64,
      allowedPaths: new Set([profile.bundle_member]),
    }).entries;
    const entry = entries[0];
    if (entries.length !== 1 || !entry || entry.bytes < 1)
      throw new Error("bootstrap attestation bundle inventory differs");
    const compressed = bundleArchive.subarray(entry.data, entry.dataEnd);
    const bundleBytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (bundleBytes.length !== entry.bytes || crc32(bundleBytes) !== entry.crc)
      throw new Error("bootstrap attestation bundle bytes differ");
    const manifestPath = path.join(directory, "manifest.json"),
      bundlePath = path.join(directory, "attestation.json");
    await writeFile(manifestPath, inspected.files.get("manifest.json")!, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(bundlePath, bundleBytes, { flag: "wx", mode: 0o600 });
    phase = "pinned-attestation-verifier";
    const statement = verifyControllerArtifactStatement(
      directory,
      manifestPath,
      bundlePath,
      expected,
      profile.predicate_type,
      { ...(spawn ? { spawn } : {}), ...(deadline === undefined ? {} : { deadline }), environment },
    );
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== profile.predicate_type ||
      JSON.stringify(statement.subject) !==
        JSON.stringify([
          { name: profile.subject, digest: { sha256: inspected.manifest_sha256 } },
        ]) ||
      !isRecord(statement.predicate) ||
      !isRecord(statement.predicate.producer)
    )
      throw new Error("bootstrap signed subject/predicate differs");
    const producer = statement.predicate.producer;
    if (
      !Number.isSafeInteger(producer.job_id) ||
      Number(producer.job_id) < 1 ||
      typeof producer.check_run_id !== "string" ||
      !/^[1-9][0-9]{0,15}$/.test(producer.check_run_id)
    )
      throw new Error("bootstrap signed numeric producer identity unavailable");
    const wanted = {
      ...predicateProfile(expected),
      role: "fixed-controller-tools",
      repository,
      repository_id: 1354613114,
      controller: {
        revision: expected.controller_revision,
        tree: expected.source_tree,
        ref: expected.controller_ref,
        workflow: productionControllerWorkflow,
      },
      producer: {
        run_id: expected.run_id,
        run_attempt: expected.run_attempt,
        job_id: producer.job_id,
        check_run_id: producer.check_run_id,
      },
      artifact: before.tools,
      manifest_sha256: inspected.manifest_sha256,
      manifest: inspected.manifest,
      compile_acceptance: "not-established",
      authority: "none",
    };
    // gh emits verified predicate JSON. Canonical comparison ignores key ordering.
    const ordered = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(ordered)
        : isRecord(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, ordered(value[key])]),
            )
          : value;
    if (JSON.stringify(ordered(statement.predicate)) !== JSON.stringify(ordered(wanted)))
      throw new Error("bootstrap signed inventory/source/artifact association differs");
    const producerJob = async () => {
      const job = await get(() => metadata.job(Number(producer.job_id)));
      if (
        !isRecord(job) ||
        job.id !== producer.job_id ||
        String(job.run_id) !== expected.run_id ||
        job.run_attempt !== expected.run_attempt ||
        job.head_sha !== expected.controller_revision ||
        job.name !== profile.job ||
        (profile.labels &&
          (!Array.isArray(job.labels) ||
            job.labels.length > 16 ||
            profile.labels.some((label) => !(job.labels as unknown[]).includes(label)))) ||
        job.status !== "completed" ||
        job.conclusion !== "success" ||
        job.check_run_url !==
          `https://api.github.com/${base}/check-runs/${String(producer.check_run_id)}`
      )
        throw new Error("bootstrap completed producer job/source/attempt differs");
      return job;
    };
    const job = await producerJob();
    phase = "provider-after";
    if (
      JSON.stringify(before) !== JSON.stringify(await snapshot()) ||
      JSON.stringify(job) !== JSON.stringify(await producerJob())
    )
      throw new Error("bootstrap provider custody changed during verification");
    phase = "materialize-only-verified-tools";
    const tools = path.join(directory, "tools");
    await mkdir(tools, { mode: 0o700 });
    for (const [name, bytes] of inspected.files) {
      remaining(15000);
      await mkdir(path.dirname(path.join(tools, name)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(tools, name), bytes, {
        flag: "wx",
        mode: name.startsWith("bin/") ? 0o700 : 0o600,
      });
    }
    const result = {
      directory,
      tools,
      source_commit: expected.controller_revision,
      source_tree: expected.source_tree,
      artifact_id: expected.artifact_id,
      archive_sha256: expected.sha256,
      manifest_sha256: inspected.manifest_sha256,
      producer: wanted.producer,
      evidence_scope:
        injectedMetadata || injectedDownload || spawn || fetch ? "injected-provider" : "github.com",
      qualification: "fixed-source tool artifact custody only",
      compile_acceptance: "not-established",
      authority: "none",
    };
    await writeFile(path.join(directory, "verification.json"), JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
    remaining(15000);
    receivedTools.set(result, {
      tools,
      files: structuredClone(inspected.manifest.files),
      manifest_sha256: inspected.manifest_sha256,
      scope: result.evidence_scope,
      expected: structuredClone(expected),
    });
    return Object.freeze(result);
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ directory, phase, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`controller tool verification refused; retain ${directory}`);
  }
}
