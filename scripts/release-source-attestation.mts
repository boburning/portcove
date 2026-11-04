import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createGitHubRunner } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
export const upstreamRehearsalExecutionRef = "refs/tags/portcove-upstream-rehearsal-20261104r1";

export interface ReleaseSourceAttestationExpectation {
  source_commit: string;
  ref: string;
  run_id: string;
  run_attempt: number;
  subjects: readonly { filename: string; sha256: string }[];
}
const repository = "boburning/portcove";
const workflow = ".github/workflows/release.yml";
type AttestationScope = "release" | "upstream-rehearsal";
function attestationWorkflow(scope: AttestationScope) {
  if (scope === "release") return workflow;
  if (scope === "upstream-rehearsal") return ".github/workflows/upstream-release-rehearsal.yml";
  throw new Error("unknown source attestation scope");
}
export const releaseProcessPredicate = "https://slsa.dev/provenance/v1";

/** Pure interpretation has no authentication authority. Only the direct gh
 * verification below establishes the signature; each consumer still checks its
 * exact producing code, original process and complete output/package bindings. */
export function inspectReleaseSourceAttestation(
  raw: unknown,
  expected: ReleaseSourceAttestationExpectation,
  scope: AttestationScope = "release",
) {
  // Native failed-only reruns can legitimately attest the same original bytes
  // in another attempt. Select the explicitly expected authenticated attempt;
  // duplicate attestations for that exact identity still refuse as ambiguous.
  if (scope === "upstream-rehearsal" && Array.isArray(raw) && raw.length > 1) {
    const uri = `https://github.com/${repository}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`;
    raw = raw.filter((value: unknown) => {
      if (
        !isRecord(value) ||
        !isRecord(value.verificationResult) ||
        !isRecord(value.verificationResult.signature) ||
        !isRecord(value.verificationResult.signature.certificate)
      )
        return false;
      return value.verificationResult.signature.certificate.runInvocationURI === uri;
    });
  }
  if (
    !Array.isArray(raw) ||
    raw.length !== 1 ||
    !isRecord(raw[0]) ||
    !isRecord(raw[0].verificationResult)
  )
    throw new Error("release report attestation is missing or ambiguous");
  const verified = raw[0].verificationResult;
  if (
    !isRecord(verified.signature) ||
    !isRecord(verified.signature.certificate) ||
    !Array.isArray(verified.verifiedTimestamps) ||
    verified.verifiedTimestamps.length < 1 ||
    !isRecord(verified.statement)
  )
    throw new Error("release report verified certificate/timestamp/statement absent");
  const certificate = verified.signature.certificate;
  if (
    certificate.issuer !== "https://token.actions.githubusercontent.com" ||
    certificate.sourceRepositoryIdentifier !== "1354613114" ||
    certificate.sourceRepositoryURI !== `https://github.com/${repository}` ||
    certificate.buildSignerURI !==
      `https://github.com/${repository}/${attestationWorkflow(scope)}@${expected.ref}` ||
    certificate.buildSignerDigest !== expected.source_commit ||
    certificate.sourceRepositoryDigest !== expected.source_commit ||
    certificate.sourceRepositoryRef !== expected.ref ||
    certificate.runnerEnvironment !== "github-hosted" ||
    certificate.runInvocationURI !==
      `https://github.com/${repository}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`
  )
    throw new Error("release report attester issuer/workflow/source/run/attempt differs");
  const statement = verified.statement;
  if (!Array.isArray(statement.subject)) throw new Error("release report subjects absent");
  const subjects = statement.subject
    .map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        !isRecord(entry.digest) ||
        typeof entry.digest.sha256 !== "string"
      )
        throw new Error("release report subject malformed");
      return entry;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const wanted = expected.subjects
    .map((entry) => ({ name: entry.filename, digest: { sha256: entry.sha256 } }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== releaseProcessPredicate ||
    !isDeepStrictEqual(subjects, wanted) ||
    !isRecord(statement.predicate)
  )
    throw new Error("release report complete exact subject matrix or predicate differs");
  return {
    authority: "none",
    certificate: structuredClone(certificate),
    statement: structuredClone(statement),
  };
}

export async function verifyReleaseSourceAttestation(
  directory: string,
  filename: string,
  expected: ReleaseSourceAttestationExpectation,
  options: {
    spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
    scope?: AttestationScope;
  } = {},
) {
  if (
    !/^[a-f0-9]{40}$/u.test(expected.source_commit) ||
    !/^[1-9][0-9]{0,15}$/u.test(expected.run_id) ||
    !Number.isSafeInteger(expected.run_attempt) ||
    expected.run_attempt < 1 ||
    !(options.scope === "upstream-rehearsal"
      ? ["refs/heads/main", upstreamRehearsalExecutionRef].includes(expected.ref)
      : /^refs\/tags\/[A-Za-z0-9._/-]{1,192}$/u.test(expected.ref)) ||
    expected.subjects.length < 1 ||
    expected.subjects.length > 8
  )
    throw new Error("exact release report verification identities unavailable");
  for (const subject of expected.subjects)
    if (
      !/^[a-f0-9]{64}$/u.test(subject.sha256) ||
      subject.filename !== path.basename(subject.filename) ||
      /[\\/\r\n\0]/u.test(subject.filename)
    )
      throw new Error("release report subject identity unsafe");
  const runner = createGitHubRunner({
    cwd: directory,
    timeoutMs: 60000,
    maxBuffer: 4 * 1024 * 1024,
    spawn:
      options.spawn ??
      ((command, args, settings) =>
        spawnSync(command, args, { ...settings, env: { ...process.env, GH_HOST: "github.com" } })),
  });
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
      `${repository}/${attestationWorkflow(options.scope ?? "release")}`,
      "--signer-digest",
      expected.source_commit,
      "--source-digest",
      expected.source_commit,
      "--source-ref",
      expected.ref,
      "--cert-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--deny-self-hosted-runners",
      "--predicate-type",
      releaseProcessPredicate,
      "--limit",
      "5",
      "--format",
      "json",
    ]),
  );
  const verificationPath = path.join(directory, "source-attestation-verification.json");
  await writeFile(verificationPath, `${JSON.stringify(raw)}\n`, { flag: "wx", mode: 0o600 });
  return {
    ...inspectReleaseSourceAttestation(raw, expected, options.scope),
    evidence_scope: options.spawn ? "injected-provider" : "github.com",
    verification_path: verificationPath,
  };
}
