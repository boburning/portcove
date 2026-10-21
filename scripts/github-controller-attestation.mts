/** Existing pinned GitHub/Sigstore verification shared by fixed controller artifacts.
 * This returns verified data; each owning consumer binds its own exact subject,
 * predicate and provider custody. No imported JSON can replace the gh execution. */
import { spawnSync } from "node:child_process";
import { createGitHubRunner } from "./github-api.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
const repository = "boburning/portcove";
export function verifyControllerArtifactStatement(
  directory: string,
  filename: string,
  bundlePath: string,
  expected: {
    controller_revision: string;
    controller_ref: string;
    run_id: string;
    run_attempt: number;
  },
  predicateType: string,
  options: {
    spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
    environment?: NodeJS.ProcessEnv;
    deadline?: number;
  } = {},
) {
  const remaining =
    options.deadline === undefined ? 30000 : Math.ceil(options.deadline - performance.now());
  if (
    !Number.isFinite(remaining) ||
    remaining < 1 ||
    (options.deadline !== undefined && remaining > 600000)
  )
    throw new Error("controller attestation phase deadline exhausted");
  const runner = createGitHubRunner({
    cwd: directory,
    spawn:
      options.spawn ??
      ((command, args, settings) =>
        spawnSync(command, args, {
          ...settings,
          env: { ...(options.environment ?? process.env), GH_HOST: "github.com" },
        })),
    maxBuffer: 1024 * 1024,
    timeoutMs: Math.min(30000, remaining),
  });
  const raw: unknown = JSON.parse(
    runner([
      "attestation",
      "verify",
      filename,
      "--bundle",
      bundlePath,
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/${productionControllerWorkflow}`,
      "--signer-digest",
      expected.controller_revision,
      "--source-digest",
      expected.controller_revision,
      "--source-ref",
      expected.controller_ref,
      "--cert-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--deny-self-hosted-runners",
      "--predicate-type",
      predicateType,
      "--format",
      "json",
    ]),
  );
  if (options.deadline !== undefined && performance.now() >= options.deadline)
    throw new Error("controller attestation phase deadline exhausted");
  if (
    !Array.isArray(raw) ||
    raw.length !== 1 ||
    !isRecord(raw[0]) ||
    !isRecord(raw[0].verificationResult)
  )
    throw new Error("aggregate bundle verification is missing or ambiguous");
  const result = raw[0].verificationResult;
  if (
    !isRecord(result.signature) ||
    !isRecord(result.signature.certificate) ||
    !Array.isArray(result.verifiedTimestamps) ||
    result.verifiedTimestamps.length < 1 ||
    !isRecord(result.statement)
  )
    throw new Error("aggregate verified certificate, timestamp or statement is absent");
  const certificate = result.signature.certificate;
  const workflowUri = `https://github.com/${repository}/${productionControllerWorkflow}@${expected.controller_ref}`;
  if (
    certificate.issuer !== "https://token.actions.githubusercontent.com" ||
    certificate.sourceRepositoryIdentifier !== "1354613114" ||
    certificate.sourceRepositoryURI !== `https://github.com/${repository}` ||
    certificate.buildSignerURI !== workflowUri ||
    certificate.buildSignerDigest !== expected.controller_revision ||
    certificate.sourceRepositoryDigest !== expected.controller_revision ||
    certificate.sourceRepositoryRef !== expected.controller_ref ||
    certificate.runnerEnvironment !== "github-hosted" ||
    certificate.runInvocationURI !==
      `https://github.com/${repository}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`
  )
    throw new Error("aggregate attester certificate identity differs");
  return result.statement;
}
