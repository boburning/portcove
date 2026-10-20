import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { loadPackagePolicy } from "./release-package-policy.mts";
import type { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const workflow = ".github/workflows/release.yml";
export const releaseSpdxPredicateType = "https://spdx.dev/Document/v2.3";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Evidence = ReturnType<typeof collectReleaseRunEvidence>;
type Spawn = NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];

/** Validate the actual SPDX graph, not merely a nonempty packages property.
 * This is document integrity, not vulnerability clearance or compiler evidence. */
export function inspectReleaseSpdx(value: unknown) {
  if (
    !isRecord(value) ||
    value.spdxVersion !== "SPDX-2.3" ||
    value.dataLicense !== "CC0-1.0" ||
    value.SPDXID !== "SPDXRef-DOCUMENT" ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 1024 ||
    typeof value.documentNamespace !== "string" ||
    !/^https?:\/\/[^\s]{1,2048}$/u.test(value.documentNamespace) ||
    Array.from(value.documentNamespace).some((character) => (character.codePointAt(0) ?? 0) < 32) ||
    !isRecord(value.creationInfo) ||
    typeof value.creationInfo.created !== "string" ||
    !Number.isFinite(Date.parse(value.creationInfo.created)) ||
    !Array.isArray(value.creationInfo.creators) ||
    value.creationInfo.creators.length > 32 ||
    !value.creationInfo.creators.some((creator) => creator === "Tool: syft-1.54.1") ||
    !Array.isArray(value.packages) ||
    value.packages.length < 1 ||
    value.packages.length > 20000 ||
    (value.files !== undefined && (!Array.isArray(value.files) || value.files.length > 20000)) ||
    !Array.isArray(value.relationships) ||
    value.relationships.length < 1 ||
    value.relationships.length > 100000
  )
    throw new Error("strict release SPDX document or pinned Syft producer is unavailable");
  const ids = new Set(["SPDXRef-DOCUMENT"]);
  const elements: unknown[] = value.packages.map((item: unknown) => item);
  if (Array.isArray(value.files)) for (const item of value.files) elements.push(item);
  for (const member of elements) {
    if (
      !isRecord(member) ||
      typeof member.SPDXID !== "string" ||
      !/^SPDXRef-[A-Za-z0-9.-]{1,256}$/u.test(member.SPDXID) ||
      ids.has(member.SPDXID)
    )
      throw new Error("SPDX graph contains invalid or duplicated element identities");
    ids.add(member.SPDXID);
  }
  for (const item of value.packages) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      item.name.length < 1 ||
      item.name.length > 1024 ||
      typeof item.downloadLocation !== "string" ||
      item.downloadLocation.length < 1 ||
      item.downloadLocation.length > 4096 ||
      typeof item.filesAnalyzed !== "boolean"
    )
      throw new Error("SPDX package identity or analysis declaration is incomplete");
  }
  let describes = false;
  for (const item of value.relationships) {
    if (
      !isRecord(item) ||
      typeof item.spdxElementId !== "string" ||
      !ids.has(item.spdxElementId) ||
      typeof item.relatedSpdxElement !== "string" ||
      !ids.has(item.relatedSpdxElement) ||
      typeof item.relationshipType !== "string" ||
      !/^[A-Z_]{1,64}$/u.test(item.relationshipType)
    )
      throw new Error("SPDX relationship escapes the complete local document graph");
    if (
      item.spdxElementId === "SPDXRef-DOCUMENT" &&
      item.relationshipType === "DESCRIBES" &&
      value.packages.some((entry) => isRecord(entry) && entry.SPDXID === item.relatedSpdxElement)
    )
      describes = true;
  }
  if (!describes) throw new Error("SPDX document does not describe its package graph");
  return {
    packages: value.packages.length,
    relationships: value.relationships.length,
    scope: "SPDX document graph only; no scanner, compiler or native acceptance",
    authority: "none",
  };
}

export function inspectVerifiedReleaseSbom(
  raw: unknown,
  expected: {
    revision: string;
    ref: string;
    run_id: string;
    run_attempt: number;
    subjects: { filename: string; sha256: string }[];
    document: unknown;
  },
) {
  if (
    !Array.isArray(raw) ||
    raw.length !== 1 ||
    !isRecord(raw[0]) ||
    !isRecord(raw[0].verificationResult)
  )
    throw new Error("SBOM verification is missing or ambiguous");
  const result = raw[0].verificationResult;
  if (
    !isRecord(result.signature) ||
    !isRecord(result.signature.certificate) ||
    !Array.isArray(result.verifiedTimestamps) ||
    !result.verifiedTimestamps.length ||
    !isRecord(result.statement)
  )
    throw new Error("SBOM signature, timestamp or statement is absent");
  const certificate = result.signature.certificate;
  if (
    certificate.issuer !== "https://token.actions.githubusercontent.com" ||
    certificate.sourceRepositoryIdentifier !== "1354613114" ||
    certificate.sourceRepositoryURI !== `https://github.com/${repository}` ||
    certificate.buildSignerURI !== `https://github.com/${repository}/${workflow}@${expected.ref}` ||
    certificate.buildSignerDigest !== expected.revision ||
    certificate.sourceRepositoryDigest !== expected.revision ||
    certificate.sourceRepositoryRef !== expected.ref ||
    certificate.runnerEnvironment !== "github-hosted" ||
    certificate.runInvocationURI !==
      `https://github.com/${repository}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`
  )
    throw new Error("SBOM attester issuer/source/workflow/run/attempt differs");
  const statement = result.statement;
  const subjects = expected.subjects
    .map((item) => ({ name: item.filename, digest: { sha256: item.sha256 } }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!Array.isArray(statement.subject)) throw new Error("SBOM subject matrix absent");
  const actual = statement.subject
    .map((item: unknown) => item)
    .sort((a: unknown, b: unknown) => {
      if (!isRecord(a) || !isRecord(b) || typeof a.name !== "string" || typeof b.name !== "string")
        throw new Error("SBOM subject identity malformed");
      return a.name.localeCompare(b.name);
    });
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== releaseSpdxPredicateType ||
    !isDeepStrictEqual(actual, subjects) ||
    !isDeepStrictEqual(statement.predicate, expected.document)
  )
    throw new Error("SBOM signed document or complete exact package subjects differ");
  return { ...inspectReleaseSpdx(statement.predicate), certificate: structuredClone(certificate) };
}

/** Existing Release attest job authenticates the SBOM document against all exact
 * package subjects. It does not authenticate original compiler use or native runs.
 * Call before the late fresh-control handshake; bracket provider evidence after. */
export async function collectReleaseSbomEvidence(
  privateRoot: string,
  rawAssembly: unknown,
  evidence: Evidence,
  options: {
    download?: typeof readGitHubArtifactArchive | undefined;
    spawn?: Spawn;
    maximumArchiveBytes?: number;
    preparedNamespace?: string;
  } = {},
) {
  const { accepted } = await inspectTrustedAssemblyInput(rawAssembly);
  if (
    evidence.repository !== repository ||
    evidence.repository_id !== 1354613114 ||
    String(evidence.run.id) !== accepted.run_id ||
    evidence.run.attempt !== accepted.run_attempt ||
    evidence.run.revision !== accepted.source_commit ||
    evidence.source_tree !== accepted.source_tree
  )
    throw new Error("SBOM provider evidence does not match exact candidate source/run/attempt");
  const name = `release-final-${accepted.run_id}-${accepted.run_attempt}`;
  const matches = evidence.artifacts.filter((artifact) => artifact.name === name);
  const selectedDispatch =
    evidence.run.event === "workflow_dispatch" &&
    accepted.release_profile === "initial-beta-win-linux";
  if (!matches.length || (evidence.run.event !== "push" && !selectedDispatch))
    return {
      state: "unknown" as const,
      evidence_scope: "none",
      authority: "none",
      reason: "selected SPDX attester/final artifact is not observed; no SBOM acceptance inferred",
    };
  if (
    selectedDispatch &&
    (!options.preparedNamespace ||
      !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(options.preparedNamespace))
  )
    throw new Error("beta SPDX requires exact existing reservation namespace");
  const attesterJobs = evidence.jobs.filter((job) => job.name === "attest");
  if (!attesterJobs.length)
    return {
      state: "unknown" as const,
      evidence_scope: "none",
      authority: "none",
      reason: "actual isolated SPDX attester job not observed",
    };
  if (
    attesterJobs.length !== 1 ||
    attesterJobs[0]!.status !== "completed" ||
    attesterJobs[0]!.conclusion !== "success"
  )
    throw new Error("SPDX attester job is ambiguous or not successful");
  if (matches.length !== 1) throw new Error("SBOM final artifact identity is ambiguous");
  const artifact = matches[0]!;
  const maximumArchiveBytes = options.maximumArchiveBytes ?? 512 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maximumArchiveBytes) ||
    maximumArchiveBytes < 22 ||
    maximumArchiveBytes > 512 * 1024 * 1024
  )
    throw new Error("SBOM additional archive would exceed the existing acquisition budget");
  if (
    artifact.expired ||
    !artifact.archive_sha256 ||
    artifact.bytes < 22 ||
    artifact.bytes > maximumArchiveBytes
  )
    throw new Error("SBOM final archive is unavailable or exceeds its bound");
  const bytes = (options.download ?? readGitHubArtifactArchive)(
    `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    { cwd: privateRoot, maxBytes: artifact.bytes, timeoutMs: 120000 },
  );
  if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.archive_sha256)
    throw new Error("SBOM final archive bytes differ from provider identity");
  const packages = accepted.files.filter(
    (file) =>
      !file.filename.startsWith("SHA256SUMS-") && !file.filename.startsWith("release-producer-"),
  );
  const checksumName = (await loadPackagePolicy()).checksum_manifest;
  const names = [...packages.map((file) => file.filename), checksumName, "Portcove-SBOM.spdx.json"];
  const { entries } = inspectBoundedZip(bytes, {
    compressedBytes: 512 * 1024 * 1024,
    expandedBytes: 2 * 1024 * 1024 * 1024,
    files: names.length,
    nameBytes: 256,
    allowedPaths: new Set(names),
  });
  if (entries.length !== names.length)
    throw new Error("SBOM final archive package matrix incomplete");
  for (const item of packages)
    if (entries.find((entry) => entry.name === item.filename)?.bytes !== item.bytes)
      throw new Error("SBOM final archive package byte count differs");
  const subject = [...packages]
    .filter((file) => file.filename.startsWith("portcove-cli-"))
    .sort((a, b) => a.bytes - b.bytes)[0];
  if (!subject) throw new Error("bounded attestation subject is unavailable");
  const retained = new Map<string, Buffer>();
  for (const filename of [subject.filename, "Portcove-SBOM.spdx.json"]) {
    const entry = entries.find((item) => item.name === filename);
    const maximum = filename === subject.filename ? 128 * 1024 * 1024 : 16 * 1024 * 1024;
    if (!entry || entry.bytes < 1 || entry.bytes > maximum)
      throw new Error("SBOM member exceeds its bound");
    const compressed = bytes.subarray(entry.data, entry.dataEnd);
    const content =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    if (
      content.length !== entry.bytes ||
      crc32(content) !== entry.crc ||
      (filename === subject.filename &&
        (content.length !== subject.bytes || sha256(content) !== subject.sha256))
    )
      throw new Error("SBOM member bytes or package subject differ");
    retained.set(filename, content);
  }
  const directory = await mkdtemp(path.join(privateRoot, "release-spdx-"));
  const filename = path.join(directory, subject.filename);
  await writeFile(filename, retained.get(subject.filename)!, { flag: "wx", mode: 0o600 });
  await writeFile(
    path.join(directory, "Portcove-SBOM.spdx.json"),
    retained.get("Portcove-SBOM.spdx.json")!,
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(path.join(directory, "artifact.json"), `${JSON.stringify(artifact)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const document: unknown = JSON.parse(retained.get("Portcove-SBOM.spdx.json")!.toString("utf8"));
  inspectReleaseSpdx(document);
  const runner = createGitHubRunner({
    cwd: directory,
    maxBuffer: 32 * 1024 * 1024,
    timeoutMs: 60000,
    spawn:
      options.spawn ??
      ((command, args, settings) =>
        spawnSync(command, args, {
          ...settings,
          env: { ...process.env, GH_HOST: "github.com" },
        })),
  });
  const ref = selectedDispatch
    ? `refs/tags/${options.preparedNamespace}-prepared/v${accepted.version}`
    : `refs/tags/v${accepted.version}`;
  const raw: unknown = JSON.parse(
    runner([
      "attestation",
      "verify",
      filename,
      "--hostname",
      "github.com",
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/${workflow}`,
      "--signer-digest",
      accepted.source_commit,
      "--source-digest",
      accepted.source_commit,
      "--source-ref",
      ref,
      "--cert-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--deny-self-hosted-runners",
      "--predicate-type",
      releaseSpdxPredicateType,
      "--limit",
      "5",
      "--format",
      "json",
    ]),
  );
  await writeFile(path.join(directory, "verification.json"), `${JSON.stringify(raw)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const inspected = inspectVerifiedReleaseSbom(raw, {
    revision: accepted.source_commit,
    ref,
    run_id: accepted.run_id,
    run_attempt: accepted.run_attempt,
    subjects: packages,
    document,
  });
  const receipt = {
    state: "verified-document" as const,
    evidence_scope: options.spawn || options.download ? "injected-provider" : "github.com",
    artifact: structuredClone(artifact),
    observed_attester_job: structuredClone(attesterJobs[0]),
    certificate_job_binding:
      "workflow/run/attempt certificate plus unique observed isolated attester job; not original compiler attribution",
    document_sha256: sha256(retained.get("Portcove-SBOM.spdx.json")!),
    subjects: packages.map(({ filename, sha256 }) => ({ filename, sha256 })),
    ...inspected,
    original_compiler: "unknown",
    native_acceptance: "unknown",
  };
  await writeFile(
    path.join(directory, "verified-spdx.json"),
    `${JSON.stringify({ receipt, verification: raw }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}
