import { createPublicKey, verify } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { isRecord } from "./runtime-values.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";

const issuer = "https://token.actions.githubusercontent.com";
const repository = "boburning/portcove";
const repositoryId = 1354613114;
/** Independently pinned github.com owner/repository IDs; no legacy-name fallback. */
export const controllerOidcSubjectPrefix = "repo:boburning@43177418/portcove@1354613114";
export type ControllerOidcEnvironment =
  | "github-pages"
  | "production-release-admission"
  | "production-payload-signing"
  | "production-release-coordinator"
  | "production-release-publication"
  | "production-release-classification"
  | "production-release-protection-observer"
  | "production-tuf-releases"
  | "production-tuf-preview"
  | "production-tuf-stable"
  | "production-tuf-snapshot"
  | "production-tuf-timestamp"
  | "production-catalog-definitions"
  | "production-catalog-policy"
  | "production-catalog-snapshot"
  | "production-catalog-timestamp";
export function controllerOidcSubject(ref: string, environment?: ControllerOidcEnvironment) {
  if (!/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(ref))
    throw new Error("controller OIDC subject requires the fixed protected tag family");
  if (
    environment !== undefined &&
    ![
      "github-pages",
      "production-release-admission",
      "production-payload-signing",
      "production-release-coordinator",
      "production-release-publication",
      "production-release-classification",
      "production-release-protection-observer",
      "production-tuf-releases",
      "production-tuf-preview",
      "production-tuf-stable",
      "production-tuf-snapshot",
      "production-tuf-timestamp",
      "production-catalog-definitions",
      "production-catalog-policy",
      "production-catalog-snapshot",
      "production-catalog-timestamp",
    ].includes(environment)
  )
    throw new Error("controller OIDC environment is unsupported");
  return `${controllerOidcSubjectPrefix}:${environment === undefined ? `ref:${ref}` : `environment:${environment}`}`;
}
type JobIdentityProfile = {
  workflow: string;
  job: string;
  environment?: ControllerOidcEnvironment | undefined;
};
const assemblerProfile = {
  workflow: productionControllerWorkflow,
  job: "Trusted package assembly",
};
const classificationProfile = {
  workflow: ".github/workflows/release-reviewed-inputs.yml",
  job: "Persist independently reviewed classification",
  environment: "production-release-classification",
} satisfies JobIdentityProfile;
const protectionProfile = {
  workflow: ".github/workflows/release-reviewed-inputs.yml",
  job: "Observe release input protections",
  environment: "production-release-protection-observer",
} satisfies JobIdentityProfile;
type Spawn = NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]>;

export interface AssemblerIdentityExpectation {
  audience: string;
  subject: string;
  controller_revision: string;
  controller_ref: string;
  actor_id: string;
  run_id: string;
  run_attempt: number;
}

function record(bytes: Buffer): Record<string, unknown> {
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error("OIDC text is not UTF-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("OIDC JSON is malformed");
  }
  if (!isRecord(parsed)) throw new Error("OIDC JSON is not an object");
  return parsed;
}

function decoded(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("OIDC encoding is malformed");
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value) throw new Error("OIDC encoding is noncanonical");
  return result;
}

async function providerKeys(timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(`${issuer}/.well-known/jwks`, {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200 || !response.body) throw new Error("OIDC provider keys unavailable");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new Error("OIDC key response is not byte data");
    size += chunk.byteLength;
    if (size > 128 * 1024) throw new Error("OIDC provider keys exceed their byte bound");
    parts.push(Buffer.from(chunk));
  }
  return record(Buffer.concat(parts));
}

export function inspectAssemblerIdentityExpectation(value: unknown): AssemblerIdentityExpectation {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "actor_id,audience,controller_ref,controller_revision,run_attempt,run_id,subject" ||
    typeof value.audience !== "string" ||
    !value.audience ||
    value.audience.length > 256 ||
    typeof value.subject !== "string" ||
    !value.subject ||
    value.subject.length > 512 ||
    typeof value.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.controller_revision) ||
    typeof value.controller_ref !== "string" ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      value.controller_ref,
    ) ||
    typeof value.actor_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(value.actor_id) ||
    typeof value.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(value.run_id) ||
    typeof value.run_attempt !== "number" ||
    !Number.isSafeInteger(value.run_attempt) ||
    value.run_attempt < 1
  )
    throw new Error("independently expected assembler identity is incomplete");
  return {
    audience: value.audience,
    subject: value.subject,
    controller_revision: value.controller_revision,
    controller_ref: value.controller_ref,
    actor_id: value.actor_id,
    run_id: value.run_id,
    run_attempt: value.run_attempt,
  };
}

/** Verify a job token's identity, not which code ran or which artifact it made.
 * Expectations come from independently ratified controller configuration and
 * the admitted invocation, never from token contents. No bearer token is saved
 * or returned. Injected readers explicitly produce fixture-scoped evidence.
 */
async function verifyJobIdentity(
  profile: JobIdentityProfile,
  token: string,
  rawExpected: unknown,
  options: {
    transport?: { cwd: string; spawn?: Spawn; deadline?: number };
    readKeys?: () => Promise<unknown>;
  } = {},
) {
  const expected = inspectAssemblerIdentityExpectation(rawExpected);
  if (expected.subject !== controllerOidcSubject(expected.controller_ref, profile.environment))
    throw new Error("independently expected OIDC subject differs from the fixed role");
  if (!options.transport) throw new Error("assembler identity transport is unconfigured");
  const remaining = () => {
    if (options.transport?.deadline === undefined) return 15000;
    const value = Math.ceil(options.transport.deadline - performance.now());
    if (!Number.isFinite(options.transport.deadline) || value < 1 || value > 600000)
      throw new Error("assembler identity total phase deadline exhausted");
    return Math.min(15000, value);
  };
  remaining();
  if (typeof token !== "string" || Buffer.byteLength(token) > 16 * 1024)
    throw new Error("OIDC token exceeds its byte bound");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OIDC token has an invalid form");
  const header = record(decoded(parts[0]!));
  const claims = record(decoded(parts[1]!));
  const signature = decoded(parts[2]!);
  if (
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    typeof header.kid !== "string" ||
    !header.kid ||
    header.kid.length > 256 ||
    Object.keys(header).some((key) => !["alg", "typ", "kid", "x5t", "x5t#S256"].includes(key))
  )
    throw new Error("OIDC header or key selection is unsupported");
  const started = performance.now();
  const keys = await (options.readKeys ?? (() => providerKeys(remaining())))();
  remaining();
  if (!isRecord(keys) || !Array.isArray(keys.keys) || keys.keys.length < 1 || keys.keys.length > 16)
    throw new Error("OIDC provider key inventory is incomplete or oversized");
  const matches = keys.keys.filter((key: unknown) => isRecord(key) && key.kid === header.kid);
  const key: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(key) ||
    key.kty !== "RSA" ||
    key.alg !== "RS256" ||
    key.use !== "sig" ||
    typeof key.n !== "string" ||
    key.n.length > 1024 ||
    typeof key.e !== "string" ||
    key.e.length > 16
  )
    throw new Error("OIDC provider signing key is missing or ambiguous");
  decoded(key.n);
  decoded(key.e);
  const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
  const bits = publicKey.asymmetricKeyDetails?.modulusLength;
  if (
    typeof bits !== "number" ||
    bits < 2048 ||
    bits > 4096 ||
    !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature)
  )
    throw new Error("OIDC signature verification failed");
  const now = Math.floor(Date.now() / 1000);
  if (
    ![claims.exp, claims.nbf, claims.iat].every(
      (value) => typeof value === "number" && Number.isSafeInteger(value),
    ) ||
    typeof claims.exp !== "number" ||
    typeof claims.nbf !== "number" ||
    typeof claims.iat !== "number" ||
    claims.exp <= now ||
    claims.nbf > now ||
    claims.iat > now ||
    claims.exp <= claims.iat ||
    claims.nbf > claims.exp
  )
    throw new Error("OIDC time bounds are invalid or expired");
  const required: Record<string, string> = {
    iss: issuer,
    aud: expected.audience,
    sub: expected.subject,
    repository,
    repository_id: String(repositoryId),
    repository_owner: "boburning",
    repository_owner_id: "43177418",
    actor_id: expected.actor_id,
    ref: expected.controller_ref,
    ref_type: "tag",
    sha: expected.controller_revision,
    workflow_sha: expected.controller_revision,
    workflow_ref: `${repository}/${profile.workflow}@${expected.controller_ref}`,
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    run_id: expected.run_id,
    run_attempt: String(expected.run_attempt),
  };
  if (
    Object.entries(required).some(([name, value]) => claims[name] !== value) ||
    (profile.environment === undefined
      ? Object.hasOwn(claims, "environment")
      : claims.environment !== profile.environment) ||
    Object.hasOwn(claims, "job_workflow_ref") ||
    Object.hasOwn(claims, "job_workflow_sha") ||
    typeof claims.check_run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(claims.check_run_id)
  )
    throw new Error("signed OIDC claims differ from the expected direct controller job");
  const expires = claims.exp;
  const checkRunId = claims.check_run_id;
  const transport = options.transport;
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({
      cwd: transport.cwd,
      ...(transport.spawn ? { spawn: transport.spawn } : {}),
      maxBuffer: 2 * 1024 * 1024,
      timeoutMs: remaining(),
    })([...args, "--hostname", "github.com"], input),
  );
  let requests = 0;
  const get = (suffix: string) => {
    remaining();
    if (++requests > 20 || performance.now() - started > 120_000 || Date.now() / 1000 >= expires)
      throw new Error("assembler identity collection deadline exhausted");
    const reply = api.request("GET", `repos/${repository}${suffix}`);
    remaining();
    if (
      reply.status !== 200 ||
      performance.now() - started > 120_000 ||
      Date.now() / 1000 >= expires
    )
      throw new Error("assembler identity response unavailable, expired or late");
    return reply.body;
  };
  const runPath = `/actions/runs/${expected.run_id}`;
  const runIdentity = (value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      String(value.id) !== expected.run_id ||
      value.run_attempt !== expected.run_attempt ||
      value.head_sha !== expected.controller_revision ||
      (value.path !== profile.workflow &&
        value.path !== `${profile.workflow}@${expected.controller_ref}`) ||
      value.event !== "workflow_dispatch" ||
      value.status !== "in_progress" ||
      !isRecord(value.repository) ||
      value.repository.id !== repositoryId ||
      value.repository.full_name !== repository ||
      !isRecord(value.head_repository) ||
      value.head_repository.id !== repositoryId
    )
      throw new Error("assembler run identity differs");
    return {
      id: value.id,
      attempt: value.run_attempt,
      sha: value.head_sha,
      path: value.path,
      event: value.event,
      status: value.status,
    };
  };
  const before = runIdentity(get(runPath));
  const jobs: Record<string, unknown>[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 16; page++) {
    const value = get(`${runPath}/attempts/${expected.run_attempt}/jobs?per_page=100&page=${page}`);
    if (
      !isRecord(value) ||
      typeof value.total_count !== "number" ||
      !Number.isSafeInteger(value.total_count) ||
      value.total_count < 1 ||
      value.total_count > 1600 ||
      (total !== null && total !== value.total_count) ||
      !Array.isArray(value.jobs) ||
      value.jobs.length > 100
    )
      throw new Error("assembler attempt job inventory is incomplete");
    total = value.total_count;
    for (const job of value.jobs) {
      if (
        !isRecord(job) ||
        typeof job.id !== "number" ||
        !Number.isSafeInteger(job.id) ||
        job.id < 1 ||
        String(job.run_id) !== expected.run_id ||
        job.run_attempt !== expected.run_attempt ||
        job.head_sha !== expected.controller_revision
      )
        throw new Error("assembler attempt job identity differs");
      jobs.push(job);
    }
    if (jobs.length === total) break;
    if (jobs.length > total || value.jobs.length !== 100 || page === 16)
      throw new Error("assembler attempt job pages are incomplete");
  }
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length)
    throw new Error("duplicate assembler job identity");
  const matching = jobs.filter(
    (job) =>
      job.check_run_url === `https://api.github.com/repos/${repository}/check-runs/${checkRunId}`,
  );
  const job = matching[0];
  if (
    matching.length !== 1 ||
    !job ||
    typeof job.id !== "number" ||
    job.status !== "in_progress" ||
    job.name !== profile.job
  )
    throw new Error("signed check-run identity does not identify one active trusted assembly job");
  const refreshed = get(`/actions/jobs/${job.id}`);
  if (
    !isRecord(refreshed) ||
    refreshed.id !== job.id ||
    String(refreshed.run_id) !== expected.run_id ||
    refreshed.run_attempt !== expected.run_attempt ||
    refreshed.head_sha !== expected.controller_revision ||
    refreshed.check_run_url !== job.check_run_url ||
    refreshed.name !== profile.job ||
    refreshed.status !== "in_progress"
  )
    throw new Error("selected assembler job changed during collection");
  const after = runIdentity(get(runPath));
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("assembler run changed during collection");
  return {
    schema_version: 1,
    kind: "oidc-job-identity-only",
    evidence_scope:
      options.readKeys || options.transport.spawn ? "injected-provider" : "github.com",
    repository_id: repositoryId,
    repository,
    workflow: profile.workflow,
    workflow_revision: expected.controller_revision,
    execution_ref: expected.controller_ref,
    actor_id: expected.actor_id,
    run_id: expected.run_id,
    run_attempt: expected.run_attempt,
    job_id: job.id,
    check_run_id: checkRunId,
    expires_at: new Date(expires * 1000).toISOString(),
    api_requests: requests,
    protection_enforcement: "unproven",
    code_execution: "unproven",
    artifact_production: "unproven",
    authority: "none",
  };
}

// Fixed profiles are deliberately private: callers cannot promote another job
// by supplying a trusted-looking name or workflow path.
type IdentityOptions = NonNullable<Parameters<typeof verifyJobIdentity>[3]>;
const capacityExecutorProfiles = Object.freeze({
  "aggregate-assembly": {
    workflow: productionControllerWorkflow,
    job: releaseControlPhaseProfile("admission").reader_name,
    environment: "production-release-admission" as const,
  },
  "payload-signing": {
    workflow: productionControllerWorkflow,
    job: releaseControlPhaseProfile("payload").reader_name,
    environment: "production-payload-signing" as const,
  },
  "tuf-releases": {
    workflow: productionControllerWorkflow,
    job: releaseControlPhaseProfile("tuf-releases").reader_name,
    environment: "production-tuf-releases" as const,
  },
  "tuf-preview": {
    workflow: productionControllerWorkflow,
    job: releaseControlPhaseProfile("tuf-preview").reader_name,
    environment: "production-tuf-preview" as const,
  },
  "tuf-stable": {
    workflow: productionControllerWorkflow,
    job: releaseControlPhaseProfile("tuf-stable").reader_name,
    environment: "production-tuf-stable" as const,
  },
  "tuf-snapshot": {
    workflow: productionControllerWorkflow,
    job: releaseControlPhaseProfile("tuf-snapshot").reader_name,
    environment: "production-tuf-snapshot" as const,
  },
  "tuf-timestamp": {
    workflow: productionControllerWorkflow,
    job: releaseControlPhaseProfile("tuf-timestamp").reader_name,
    environment: "production-tuf-timestamp" as const,
  },
  "catalog-definitions": {
    workflow: productionControllerWorkflow,
    job: "Sign catalog definitions",
    environment: "production-catalog-definitions" as const,
  },
  "catalog-policy": {
    workflow: productionControllerWorkflow,
    job: "Sign catalog policy",
    environment: "production-catalog-policy" as const,
  },
  "catalog-snapshot": {
    workflow: productionControllerWorkflow,
    job: "Sign catalog snapshot",
    environment: "production-catalog-snapshot" as const,
  },
  "catalog-timestamp": {
    workflow: productionControllerWorkflow,
    job: "Sign catalog timestamp",
    environment: "production-catalog-timestamp" as const,
  },
  coordinator: {
    workflow: productionControllerWorkflow,
    job: "Coordinate application release",
    environment: "production-release-coordinator" as const,
  },
  "release-publication": {
    workflow: productionControllerWorkflow,
    job: "Publish immutable application release",
    environment: "production-release-publication" as const,
  },
  "site-publication": {
    workflow: productionControllerWorkflow,
    job: "Publish authenticated application site",
    environment: "github-pages" as const,
  },
});
export type CapacityExecutorRole = keyof typeof capacityExecutorProfiles;

/** Fixed coordinator/publication profiles; names supplied by a caller cannot
 * appoint another job. Identity verification alone grants no effect authority. */
export async function verifyCapacityExecutorJobIdentity(
  role: CapacityExecutorRole,
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  if (!Object.hasOwn(capacityExecutorProfiles, role))
    throw new Error("capacity executor role is not a fixed controller profile");
  const observed = await verifyJobIdentity(
    capacityExecutorProfiles[role],
    token,
    expected,
    options,
  );
  return { ...observed, role };
}
/** Fresh producer identity only; receivers authenticate the existing GitHub
 * attestation instead of retaining or accepting an expired bearer token. */
export function verifyControllerToolBootstrapJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyJobIdentity(
    { workflow: productionControllerWorkflow, job: "Prepare trusted application controller tools" },
    token,
    expected,
    options,
  );
}
export function verifyAssemblerJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyJobIdentity(assemblerProfile, token, expected, options);
}
/** Complete pipeline's admitted assembler; the legacy plain-ref job remains
 * a separate fixed profile and cannot stand in for this protected reader. */
export function verifyAdmittedAssemblerJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyJobIdentity(
    capacityExecutorProfiles["aggregate-assembly"],
    token,
    expected,
    options,
  );
}
export function verifyPayloadSignerJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyReleaseControlReaderJobIdentity("payload", token, expected, options);
}
export function verifyClassificationWriterJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyJobIdentity(classificationProfile, token, expected, options);
}
export function verifyProtectionObserverJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyJobIdentity(protectionProfile, token, expected, options);
}
/** Same selected D1 principals, bound to the complete immutable controller. */
export function verifyProductionClassificationWriterJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyJobIdentity(
    { ...classificationProfile, workflow: productionControllerWorkflow },
    token,
    expected,
    options,
  );
}
export function verifyProductionClassificationObserverJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  return verifyJobIdentity(
    { ...protectionProfile, workflow: productionControllerWorkflow },
    token,
    expected,
    options,
  );
}
export function verifyProductionProtectionObserverJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
  phase: unknown = "admission",
) {
  const profile = releaseControlPhaseProfile(phase);
  return verifyJobIdentity(
    {
      workflow: productionControllerWorkflow,
      job: profile.observer_name,
      environment: profile.observer_environment,
    },
    token,
    expected,
    options,
  );
}
export function verifyReleaseInputReaderJobIdentity(
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  // Original schema-1 read-only admission route. Complete-workflow admission
  // uses the environment-bound phase verifier below before any journal access.
  return verifyJobIdentity(
    {
      workflow: productionControllerWorkflow,
      job: releaseControlPhaseProfile("admission").reader_name,
    },
    token,
    expected,
    options,
  );
}
export function verifyReleaseControlReaderJobIdentity(
  phase: unknown,
  token: string,
  expected: unknown,
  options: IdentityOptions = {},
) {
  const profile = releaseControlPhaseProfile(phase);
  return verifyJobIdentity(
    {
      workflow: productionControllerWorkflow,
      job: profile.reader_name,
      environment: profile.reader_environment,
    },
    token,
    expected,
    options,
  );
}

export async function requestAssemblerToken(
  audience: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  deadline?: number,
) {
  const remaining = () => {
    const left = deadline === undefined ? 15000 : Math.floor(deadline - performance.now());
    if (!Number.isFinite(left) || left < 1 || (deadline !== undefined && left > 600000))
      throw new Error("runner OIDC phase deadline exhausted");
    return Math.min(15000, left);
  };
  remaining();
  // These are runner-issued control variables, never dispatch/candidate values.
  const endpoint = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  const bearer = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    !endpoint.hostname.endsWith(".actions.githubusercontent.com") ||
    !bearer ||
    bearer.length > 16384
  )
    throw new Error("runner OIDC endpoint is unavailable");
  endpoint.searchParams.set("audience", audience);
  const response = await fetcher(endpoint, {
    headers: { Authorization: `Bearer ${bearer}` },
    redirect: "error",
    signal: AbortSignal.timeout(remaining()),
  });
  remaining();
  if (response.status !== 200 || !response.body) throw new Error("runner OIDC request refused");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    remaining();
    length += chunk.byteLength;
    if (length > 32 * 1024) throw new Error("runner OIDC response exceeds bound");
    chunks.push(Buffer.from(chunk));
  }
  remaining();
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(result) || typeof result.value !== "string" || result.value.length > 16384)
    throw new Error("runner OIDC response is invalid");
  return result.value;
}
