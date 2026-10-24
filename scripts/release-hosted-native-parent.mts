/** Actual fixed-parent source/issuer binding only. This is not a candidate
 * invocation, OS boundary, native result, reservation or signing capability. */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  admitProductionNativeParent,
  productionHostedNativeJob,
  readProductionControllerWorkflowBytes,
  requireAdmittedProductionSource,
} from "./production-controller-admission.mts";
import { inspectBoundSelectedPublicationAuthorities } from "./release-authority-configuration-contract.mts";
import {
  controllerOidcSubject,
  hostedNativeJobProfile,
  requestAssemblerToken,
  verifyHostedNativeJobIdentity,
  requireVerifiedHostedNativeJobIdentity,
} from "./assembler-job-identity.mts";
import { inspectHostedNativeProducer } from "./release-hosted-native-proof-contract.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";

const sourceKeys = [
  "GITHUB_ACTIONS",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REF_TYPE",
  "GITHUB_REF_PROTECTED",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_ACTOR_ID",
  "GITHUB_ACTOR",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_JOB",
  "RUNNER_ENVIRONMENT",
  "PORTCOVE_CONTROLLER_REVISION",
  "PORTCOVE_CONTROLLER_REF",
  "PORTCOVE_CONTROLLER_ADMISSION",
  "PORTCOVE_RELEASE_AUTHORITIES",
  "PORTCOVE_EXECUTION_PURPOSE",
  "GH_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
] as const;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const parents = new WeakMap<
  object,
  {
    snapshot: string;
    directory: string;
    source: ReturnType<typeof admitProductionNativeParent>;
    configuration: ReturnType<typeof inspectBoundSelectedPublicationAuthorities>["configuration"];
    identity: Awaited<ReturnType<typeof verifyHostedNativeJobIdentity>>;
    expected: Parameters<typeof verifyHostedNativeJobIdentity>[2];
    producer: ReturnType<typeof inspectHostedNativeProducer>;
    platform: "windows-x86_64" | "linux-x86_64";
    stage: "payload-signing" | "release-publication";
    files: ReadonlyMap<string, Buffer>;
    active: () => void;
    stopped: boolean;
  }
>();

export async function createActualHostedNativeParentSource(
  parent: string,
  platform: "windows-x86_64" | "linux-x86_64",
  stage: "payload-signing" | "release-publication",
  originalDeadline: number,
) {
  const job = productionHostedNativeJob(platform, stage);
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    sourceKeys.map((key) => [key, process.env[key]]),
  );
  if (!Number.isFinite(originalDeadline) || originalDeadline - performance.now() > 1900000)
    throw new Error("bounded original hosted native parent deadline required");
  const active = () => {
    if (performance.now() >= originalDeadline)
      throw new Error("original hosted native parent deadline exhausted");
    for (const key of sourceKeys)
      if (environment[key] !== process.env[key])
        throw new Error("hosted native parent source or credential boundary changed");
  };
  active();
  if (
    !environment.PORTCOVE_RELEASE_AUTHORITIES ||
    Buffer.byteLength(environment.PORTCOVE_RELEASE_AUTHORITIES) > 32768
  )
    throw new Error("full selected native parent configuration required");
  const workflow = await readProductionControllerWorkflowBytes();
  active();
  const source = admitProductionNativeParent(
    environment.PORTCOVE_CONTROLLER_ADMISSION,
    environment,
    workflow,
    platform,
    stage,
  );
  requireAdmittedProductionSource(source, job, "application");
  const runId = source.run_id;
  if (typeof runId !== "string") throw new Error("original native parent run required");
  const bound = inspectBoundSelectedPublicationAuthorities(
    JSON.parse(environment.PORTCOVE_RELEASE_AUTHORITIES) as unknown,
    source,
    "application",
  );
  if (bound.configuration.purpose !== "application")
    throw new Error("native application parent source required");
  if (
    !path.isAbsolute(parent) ||
    (await realpath(parent)) !== path.resolve(parent) ||
    !(await lstat(parent)).isDirectory()
  )
    throw new Error("canonical owned native parent directory required");
  active();
  const directory = await mkdtemp(path.join(parent, "hosted-native-parent-"));
  await chmod(directory, 0o700);
  let phase = "source-retention";
  try {
    active();
    const configuration = bound.configuration;
    const files = new Map<string, Buffer>();
    const retain = async (name: string, value: unknown, limit: number) => {
      const bytes = Buffer.from(JSON.stringify(value));
      if (!bytes.length || bytes.length > limit)
        throw new Error("native parent evidence exceeds bound");
      await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
      files.set(name, bytes);
      active();
    };
    await retain("source.json", { source, platform, stage, job, authority: "none" }, 8192);
    await retain("configuration.json", configuration, 32768);
    phase = "original-issuer-job";
    const profile = hostedNativeJobProfile(platform);
    const expected = {
      audience: profile.audience,
      subject: controllerOidcSubject(source.execution_ref, profile.environment),
      controller_revision: source.revision,
      controller_ref: source.execution_ref,
      actor_id: source.actor_id,
      run_id: runId,
      run_attempt: source.run_attempt,
    };
    const identityDeadline = Math.min(originalDeadline, performance.now() + 120000);
    const identity = await withReadOnlyReleaseChildren(directory, async () => {
      active();
      const token = await requestAssemblerToken(
        profile.audience,
        environment,
        fetch,
        identityDeadline,
      );
      active();
      return verifyHostedNativeJobIdentity(platform, token, expected, {
        transport: { cwd: directory, deadline: identityDeadline },
      });
    });
    active();
    requireVerifiedHostedNativeJobIdentity(identity, platform, expected);
    // Anchor the original certificate/JWT expiry to monotonic time once. A
    // wall-clock rollback or later getter cannot renew this parent lifetime.
    const deadline = Math.min(
      originalDeadline,
      performance.now() + Date.parse(identity.expires_at) - Date.now(),
    );
    const live = () => {
      active();
      if (performance.now() >= deadline)
        throw new Error("original native parent issuer lifetime exhausted");
      requireAdmittedProductionSource(source, job, "application");
      requireVerifiedHostedNativeJobIdentity(identity, platform, expected);
    };
    live();
    const producer = inspectHostedNativeProducer(
      {
        controller_revision: source.revision,
        controller_ref: source.execution_ref,
        actor_id: source.actor_id,
        configuration_sha256: bound.configuration_sha256,
        grant_sha256: source.grant_sha256,
        setup_sha256: configuration.journal.setup_plan_sha256,
        workflow_sha256: hash(workflow),
        run_id: identity.run_id,
        run_attempt: identity.run_attempt,
        job_id: identity.job_id,
        check_run_id: identity.check_run_id,
      },
      platform,
    );
    phase = "identity-retention";
    await retain("identity.json", { identity, producer, authority: "none" }, 8192);
    live();
    const receipt = Object.freeze({
      kind: "hosted-native-parent-source",
      directory,
      platform_label: platform,
      stage,
      namespace: configuration.journal.namespace,
      native_acceptance: "not-established",
      authority: "none",
    });
    parents.set(receipt, {
      snapshot: JSON.stringify(receipt),
      directory,
      source,
      configuration,
      identity,
      expected,
      producer,
      platform,
      stage,
      files,
      active: live,
      stopped: false,
    });
    return receipt;
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        phase,
        authority: "none",
        automatic_retry: false,
        native_acceptance: "not-established",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`hosted native parent source refused; retain ${directory}`);
  }
}

/** Re-read the original retained source/configuration/identity and both original
 * clocks. No provider refresh, candidate launch or imported-report admission. */
export async function requireActualHostedNativeParentSource(receipt: object) {
  const retained = parents.get(receipt);
  if (!retained || retained.stopped || retained.snapshot !== JSON.stringify(receipt))
    throw new Error("original active hosted native parent source required");
  try {
    retained.active();
    for (const [name, expected] of retained.files) {
      const bytes = await readControllerToolFile(
        path.join(retained.directory, name),
        expected.length,
      );
      if (!bytes.equals(expected)) throw new Error("native parent retained evidence changed");
      retained.active();
    }
    return Object.freeze({
      directory: retained.directory,
      configuration: structuredClone(retained.configuration),
      producer: structuredClone(retained.producer),
      platform_label: retained.platform,
      stage: retained.stage,
      authority: "none" as const,
      scope: "original source and issuer identity only" as const,
      candidate_isolation: "unproven" as const,
      native_acceptance: "not-established" as const,
    });
  } catch (error) {
    retained.stopped = true;
    throw error;
  }
}
