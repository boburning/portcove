import {
  createReleasePublicationReader,
  peelReleaseReference,
  releasePublicationRefsQuery as refsQuery,
} from "./release-publication-inventory.mts";
import {
  assessBoundedCapacity,
  capacityDigest,
  slice4CapacityResourceDigest,
} from "./release-capacity.mts";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import {
  collectReleaseSbomEvidence,
  requireVerifiedReleaseSbomDocument,
} from "./release-acceptance-evidence.mts";
import { compareVerifiedReleaseCompilerSource } from "./release-compiler-source-admission.mts";
import {
  collectReleaseCompilerEvidence,
  requireVerifiedReleaseCompilerEvidence,
} from "./release-compiler-evidence.mts";
import {
  requiredCheckContexts,
  requiredContextsFromConfigs,
  PullRequestDeliveryClient,
} from "./pr-delivery.mts";
import {
  loadPackagePolicy,
  releaseLabels,
  releaseBuildArtifactName,
  inspectReleaseProfile,
  selectReleasePackagePolicy,
} from "./release-package-policy.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { discoverReleaseArtifactFiles } from "./release-artifact-archive.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import {
  inspectPublicBuildConfiguration,
  selectPublicBuildInputBinding,
  verifyReleasePublicBuildInputs,
  requireStablePublicBuildInputEvidence,
  requireVerifiedReleasePublicBuildInputs,
} from "./release-public-build-provenance.mts";
import { planReleaseOpportunity } from "./release-coordinator.mts";
import {
  classifyApplicationVersion,
  parseVersionClassification,
} from "../apps/desktop/scripts/release-version-policy.mts";
import { collectReleaseSourceChanges, netTreeDeltaScope } from "./release-source-changes.mts";
import { isRecord } from "./runtime-values.mts";
import { isDeepStrictEqual } from "node:util";
import { retainAggregateStepReceipt } from "./production-aggregate-steps.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { releaseControlRefQuery } from "./release-control-inputs.mts";
import {
  authenticateReleaseControlSource,
  authenticateControlReaderJob,
  requireAuthenticatedReleaseControlSource,
} from "./release-live-control-admission.mts";
import type { AuthenticatedReleaseControlSource } from "./release-live-control-admission.mts";
import { readProductionControllerWorkflowBytes } from "./production-controller-admission.mts";
import { prepareControlReadiness, waitForControlArtifact } from "./release-control-handshake.mts";
import { inspectReleaseControlPhase } from "./release-control-phases.mts";
import type { ReleaseControlPhase } from "./release-control-phases.mts";
import {
  requireNativeReleaseQualificationPair,
  collectConfiguredNativeReleaseQualificationPair,
} from "./release-native-admission.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source-closure.mts";
import { requireControllerReleaseAuthorities } from "./release-authority-configuration.mts";
import type { NativeQualificationStage } from "./release-native-qualification-contract.mts";
import type { VerifiedNativeReleaseQualification } from "./release-native-acceptance.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const repository = "boburning/portcove";
const base = `repos/${repository}`;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
// A caller-supplied option/JSON field cannot activate qualifying acquisition.
const qualifyingCollections = new WeakSet<object>();
const publicationCompletionCollections = new WeakSet<object>();
const acquiredCandidates = new WeakMap<object, Readonly<Record<string, unknown>>>();
export interface ActualCandidateBuildingEligibility {
  stage: "candidate-building";
  repository: string;
  checkpoint: string;
  candidate: Readonly<Record<string, unknown>>;
  facts: Readonly<PreparedReleaseAdmissionFacts>;
  controls: AuthenticatedReleaseControlSource;
  admission: Readonly<Awaited<ReturnType<typeof acquireReleaseAdmission>>>;
  reader: Readonly<Awaited<ReturnType<typeof authenticateControlReaderJob>>>;
  namespace: string;
  controller_tools: object;
  native_qualifications: readonly object[];
  sbom_receipt: object;
  public_build_inputs_receipt: object;
  pending_obligations: readonly string[];
}
const actualBuildingEligibility = new WeakMap<object, ActualCandidateBuildingEligibility>();
/** Data-only stage association. Candidate building consumes pre-sign native
 * qualification, but is never itself payload-signing admission. */
export function inspectAdmissionNativeStage(
  phase: unknown,
  admissionStage: unknown,
): NativeQualificationStage {
  if (
    (phase === "admission" && admissionStage === "candidate-building") ||
    (phase === "payload" && admissionStage === "payload-signing")
  )
    return "payload-signing";
  if (phase === "release-publication" && admissionStage === "release-publication")
    return "release-publication";
  throw new Error("actual admission context cannot appoint another execution stage");
}
type Api = Pick<GitHubApiClient, "request" | "graphql">;
type Recover = (...args: Parameters<typeof recoverRemoteCoordinator>) => Promise<unknown>;
export interface PreparedReleaseAdmissionFacts {
  checkpoint: string;
  configuration: unknown;
  opportunity: unknown;
  assembly: unknown;
  archives: readonly { platform: string; artifact_id: number; bytes: number; sha256: string }[];
  public_build_inputs: unknown;
  evidence: ReturnType<typeof collectReleaseRunEvidence>;
  contexts: unknown;
  allocations: unknown;
  compiler_evidence?: unknown;
  native_evidence?: readonly {
    check_id: number;
    report_sha256: string;
    stage: NativeQualificationStage;
  }[];
}
export interface ReleaseCompilerAdmissionPrerequisite {
  controller_tools: object;
  controller_source: { source_commit: string; source_tree: string };
}
export interface ActualReleaseAdmissionContext {
  stage: "payload-signing" | "release-publication";
  facts: Readonly<PreparedReleaseAdmissionFacts>;
  controls: AuthenticatedReleaseControlSource;
  admission: Readonly<Awaited<ReturnType<typeof acquireReleaseAdmission>>>;
  checkpoint: string;
  native_qualifications: readonly object[];
  coordinator_repository: string;
  sbom_receipt: object;
  public_build_inputs_receipt: object;
  pending_obligations: readonly string[];
}
const actualAdmissionContexts = new WeakMap<
  object,
  { context: Readonly<ActualReleaseAdmissionContext>; phase: ReleaseControlPhase }
>();
const actualPublicationCompletionContexts = new WeakMap<
  object,
  Readonly<ActualReleaseAdmissionContext>
>();
/** The fixed publisher may reconstruct settled output after a promoting phase
 * crash. This separate brand never enters the ordinary effect admission map. */
export function requireActualPublicationControllerContext(raw: object) {
  const completion = actualPublicationCompletionContexts.get(raw);
  if (!completion)
    return {
      mode: "publication" as const,
      context: requireActualReleaseAdmissionContext(raw, "release-publication"),
    };
  if (
    completion.stage !== "release-publication" ||
    completion.admission.decision !== "admitted" ||
    completion.admission.holds.length ||
    completion.admission.evidence_scope !== "github.com" ||
    completion.controls.evidence_scope !== "github.com" ||
    completion.facts.checkpoint !== completion.checkpoint
  )
    throw new Error("actual promoting readback context required");
  requireAuthenticatedReleaseControlSource(completion.controls, "release-publication");
  return { mode: "completion-only" as const, context: completion };
}
const acquiredSbomReceipts = new WeakMap<object, object>();
const acquiredNativeReceipts = new WeakMap<object, readonly object[]>();
const acquiredCoordinatorRepositories = new WeakMap<object, string>();
const acquiredPublicInputReceipts = new WeakMap<object, object>();
/** Same-process authority continuation only. Serialization, imported snapshots,
 * fixture source brands and an assembly artifact cannot mint this context. Each
 * protected consumer must still perform its own fresh controls/reservation check. */
export function requireActualReleaseAdmissionContext(
  raw: object,
  expectedStage: ActualReleaseAdmissionContext["stage"],
): Readonly<ActualReleaseAdmissionContext> {
  const retained = actualAdmissionContexts.get(raw);
  if (
    !retained ||
    !["payload-signing", "release-publication"].includes(expectedStage) ||
    retained.context.stage !== expectedStage ||
    retained.context.admission.decision !==
      (expectedStage === "payload-signing" ? "eligible-for-payload-signing" : "admitted") ||
    retained.context.admission.holds.length !== 0 ||
    retained.context.admission.evidence_scope !== "github.com" ||
    retained.context.controls.evidence_scope !== "github.com" ||
    retained.context.facts.checkpoint !== retained.context.checkpoint ||
    retained.context.admission.checkpoint !== retained.context.checkpoint
  )
    throw new Error("actual same-process zero-hold release admission context required");
  requireAuthenticatedReleaseControlSource(retained.context.controls, retained.phase);
  return retained.context;
}
function freezePreparedFacts<T>(value: T, depth = 0): T {
  if (depth > 32) throw new Error("private prepared facts nesting bound exceeded");
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezePreparedFacts(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}

function oid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("admission requires exact Git object identity");
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("admission requires positive numeric identity");
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("admission provider record is incomplete");
  return value;
}
function configuration(raw: unknown) {
  const value = record(raw);
  if (
    !(
      (value.schema_version === 1 &&
        Object.keys(value).sort().join(",") === "namespace,schema_version") ||
      (value.schema_version === 2 &&
        Object.keys(value).sort().join(",") === "namespace,release_profile,schema_version") ||
      (value.schema_version === 3 &&
        value.release_profile === "initial-beta-win-linux" &&
        Object.keys(value).sort().join(",") ===
          "namespace,public_build_inputs,release_profile,schema_version")
    ) ||
    typeof value.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(value.namespace) ||
    value.namespace.length > 64
  )
    throw new Error("admission needs separately ratified coordinator configuration");
  return {
    schema_version: value.schema_version,
    namespace: value.namespace,
    public_build_inputs:
      value.schema_version === 3
        ? inspectPublicBuildConfiguration(value.public_build_inputs)
        : null,
    release_profile:
      value.schema_version === 2 || value.schema_version === 3
        ? inspectReleaseProfile(value.release_profile)
        : ("full" as const),
  };
}
/** Executable remote-read-only gate. Acquires facts; never allocates, writes a
 * ref, executes candidate code or equates provider identity with acceptance.
 * Unconfigured independent control/producer authorities remain explicit holds.
 */
export async function acquireReleaseAdmission(
  privateRoot: string,
  rawConfiguration: unknown,
  rawOptions: {
    api?: Api;
    recover?: Recover;
    download?: typeof readGitHubArtifactArchive;
    now?: () => number;
    capacity?: { ratification: unknown; readBoundary: () => Promise<unknown> };
    controls?: AuthenticatedReleaseControlSource;
    controlPhase?: ReleaseControlPhase;
    compiler?: ReleaseCompilerAdmissionPrerequisite;
    // Inert updater package custody only; full archive verification precedes it.
    retainDesktopPackage?: NonNullable<
      Parameters<typeof discoverReleaseArtifactFiles>[4]
    >["retainDesktopPackage"];
    // Fixed caller obtains actual native Check receipts against these privately
    // acquired candidate facts. Serialized reports are never prerequisites.
    establishNative?: (
      facts: Readonly<PreparedReleaseAdmissionFacts>,
    ) => Promise<readonly object[]>;
    // Called once after all large immutable archives have been privately
    // validated. The same process retains its facts; no serialized facts import.
    establishControls?: (
      preparedFactsSha256: string,
      facts: Readonly<PreparedReleaseAdmissionFacts>,
    ) => Promise<AuthenticatedReleaseControlSource>;
  } = {},
) {
  const qualifyingOnly = qualifyingCollections.has(rawOptions);
  const allowPublicationCompletion = publicationCompletionCollections.has(rawOptions);
  // Preserve actual/injected transport provenance and capability references
  // throughout asynchronous acquisition. A caller cannot clear an injected
  // option after collection to obtain a production context.
  const options = Object.freeze({
    ...rawOptions,
    ...(rawOptions.compiler
      ? {
          compiler: Object.freeze({
            ...rawOptions.compiler,
            controller_source: structuredClone(rawOptions.compiler.controller_source),
          }),
        }
      : {}),
  });
  const controlPhase = inspectReleaseControlPhase(options.controlPhase);
  if (qualifyingOnly && controlPhase !== "admission")
    throw new Error("qualifying collection requires its fixed independent reader phase");
  const nativeStage: NativeQualificationStage =
    controlPhase === "release-publication" ? "release-publication" : "payload-signing";
  let nativeReceipts: readonly object[] | null = null;
  let nativeReports: readonly VerifiedNativeReleaseQualification[] | null = null;
  if (options.controls) requireAuthenticatedReleaseControlSource(options.controls, controlPhase);
  if (options.controls && options.establishControls)
    throw new Error("admission accepts exactly one live control establishment path");
  let controls = options.controls;
  const capacitySource = options.capacity
    ? {
        ratification: structuredClone(options.capacity.ratification),
        readBoundary: options.capacity.readBoundary,
      }
    : undefined;
  const config = configuration(structuredClone(rawConfiguration));
  const started = performance.now();
  const root = await mkdtemp(path.join(path.resolve(privateRoot), "release-admission-"));
  let phase = "initialize";
  let checkpoint: string | null = null;
  let requests = 0;
  try {
    const rawApi =
      options.api ??
      new GitHubApiClient((args, input) =>
        createGitHubRunner({ cwd: root, maxBuffer: 2 * 1024 * 1024, timeoutMs: 15000 })(
          [...args, "--hostname", "github.com"],
          input,
        ),
      );
    let apiMilliseconds = 0;
    const budget = () => {
      if (
        ++requests > 160 ||
        apiMilliseconds > 120000 ||
        performance.now() - started > 15 * 60 * 1000
      )
        throw new Error("admission API acquisition bound exhausted");
    };
    const api: Api = {
      request(method, endpoint, body) {
        const url = new URL(
          endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
        );
        const route = url.pathname.slice(`/repos/${repository}`.length);
        const comparison = /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/u.test(route);
        const tree = /^\/git\/trees\/[a-f0-9]{40}$/u.test(route);
        const collection =
          comparison ||
          /^(?:\/releases|\/actions\/runs\/[1-9][0-9]*\/(?:artifacts|attempts\/[1-9][0-9]*\/jobs)|\/commits\/[a-f0-9]{40}\/(?:check-runs|status))$/u.test(
            route,
          );
        const contents = route === "/contents/.github/workflows/release.yml";
        const single =
          route === "" ||
          /^\/(?:git\/(?:commits|blobs)\/[a-f0-9]{40}|check-runs\/[1-9][0-9]*|actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*)?)$/u.test(
            route,
          );
        const keys = [...url.searchParams.keys()];
        if (
          method !== "GET" ||
          body != null ||
          url.origin !== "https://api.github.com" ||
          url.username ||
          url.password ||
          url.hash ||
          (url.pathname !== `/repos/${repository}` &&
            !url.pathname.startsWith(`/repos/${repository}/`)) ||
          (!collection && !contents && !single && !tree) ||
          new Set(keys).size !== keys.length ||
          keys.some(
            (key) =>
              !(
                collection
                  ? ["per_page", "page", ...(route.endsWith("/check-runs") ? ["filter"] : [])]
                  : tree
                    ? ["recursive"]
                    : contents
                      ? ["ref"]
                      : []
              ).includes(key),
          ) ||
          (collection &&
            (url.searchParams.get("per_page") !== "100" ||
              (url.searchParams.has("page") &&
                !/^(?:[1-9]|1[0-6])$/u.test(url.searchParams.get("page") ?? "")))) ||
          (route.endsWith("/check-runs") && url.searchParams.get("filter") !== "latest") ||
          (tree && keys.length !== 0 && url.searchParams.get("recursive") !== "1") ||
          (contents && !/^[a-f0-9]{40}$/u.test(url.searchParams.get("ref") ?? ""))
        )
          throw new Error("admission traversal escaped its remote-read-only repository");
        budget();
        const requestStarted = performance.now();
        const response = rawApi.request("GET", endpoint);
        apiMilliseconds += performance.now() - requestStarted;
        if (
          response.status !== 200 ||
          apiMilliseconds > 120000 ||
          performance.now() - started > 15 * 60 * 1000
        )
          throw new Error("admission API source unavailable or late");
        return response;
      },
      graphql(query, variables) {
        if (query !== refsQuery && query !== releaseControlRefQuery)
          throw new Error("admission permits only the fixed read-only ref query");
        budget();
        const requestStarted = performance.now();
        const response = rawApi.graphql(query, variables);
        apiMilliseconds += performance.now() - requestStarted;
        if (apiMilliseconds > 120000 || performance.now() - started > 15 * 60 * 1000)
          throw new Error("admission ref acquisition was late");
        return response;
      },
    };
    phase = "repository-and-reservation";
    const publicationReader = createReleasePublicationReader(api);
    const { tags, releases } = publicationReader;
    const recover = () =>
      (options.recover ?? recoverRemoteCoordinator)(
        root,
        { schema_version: 1, namespace: config.namespace },
        { transport: { cwd: root } },
      );
    const before = record(structuredClone(await recover()));
    oid(before.checkpoint);
    checkpoint = before.checkpoint;
    const state = record(before.input);
    const candidate = record(state.active_candidate);
    if (
      qualifyingOnly
        ? candidate.phase !== "qualifying"
        : ![
            "building",
            "publishing",
            ...(allowPublicationCompletion ? ["promoting"] : []),
          ].includes(String(candidate.phase))
    )
      throw new Error("admission cannot revive an inactive or failed candidate");
    for (const key of ["source_commit", "source_tree", "prepared_commit", "prepared_tree"])
      oid(candidate[key]);
    if (typeof candidate.version !== "string" || !isRecord(candidate.release_run))
      throw new Error("admission requires the existing frozen Release run");
    const version = classifyApplicationVersion(candidate.version).version;
    integer(candidate.release_run.run_id);
    integer(candidate.release_run.attempt);
    if (candidate.release_run.revision !== candidate.prepared_commit)
      throw new Error("admission frozen run differs from prepared source");
    const initialTags = tags();
    const initialReleases = releases();
    const { allocations, intents } = publicationReader.readAllocations(
      initialTags,
      config.namespace,
    );
    const activePreparationIntent = intents.get(version) ?? null;
    const active = allocations.find((a) => a.version === version);
    if (
      !active ||
      ["source_commit", "source_tree", "prepared_commit", "prepared_tree", "intent_sha256"].some(
        (key) => active[key as keyof typeof active] !== candidate[key],
      )
    )
      throw new Error("active reservation differs from complete namespace receipts");
    const holds = new Set<string>();
    let controlsBefore: ReturnType<AuthenticatedReleaseControlSource["read"]> | null = null;
    let controlsAfter: ReturnType<AuthenticatedReleaseControlSource["read"]> | null = null;
    let frozenControlsOpportunity: unknown = null;
    // Separate live source seam; retained coordinator facts cannot self-attest
    // a current provider boundary. Missing/invalid input holds independently.
    let capacityBefore: unknown = null;
    try {
      capacityBefore = capacitySource ? structuredClone(await capacitySource.readBoundary()) : null;
    } catch {
      /* unknown stays held */
    }

    let sourceChanges: ReturnType<typeof collectReleaseSourceChanges> | null = null;
    phase = "source-consistency";
    if (!Object.hasOwn(candidate, "frozen_opportunity")) {
      holds.add("active-frozen-opportunity-unavailable-no-latest-opportunity-substitution");
    } else {
      const frozen = record(candidate.frozen_opportunity);
      const classification = record(frozen.classification);
      if (
        frozen.source_commit !== active.source_commit ||
        frozen.source_tree !== active.source_tree ||
        classification.source_commit !== active.source_commit ||
        classification.reviewed_commit !== active.source_commit ||
        classification.source_tree !== active.source_tree ||
        classification.reviewed_tree !== active.source_tree
      )
        throw new Error("frozen classification differs from the active original source");
      if (classification.change_set_scope !== netTreeDeltaScope) {
        holds.add("frozen-change-set-scope-unsupported-no-legacy-hash-reinterpretation");
      } else {
        sourceChanges = collectReleaseSourceChanges(api, frozen);
        if (
          sourceChanges.change_set_sha256 !== frozen.change_set_sha256 ||
          sourceChanges.change_set_sha256 !== classification.change_set_sha256
        )
          throw new Error("frozen change-set digest differs from acquired complete source facts");
        const parsed = parseVersionClassification(classification);
        // Associate the already-frozen proposal rather than fabricating its
        // historical publication input or reallocating on a later retry.
        const intent = record(JSON.parse(activePreparationIntent ?? "null"));
        const proposal = record(intent.proposal);
        const classified = classifyApplicationVersion(version);
        if (
          Object.keys(intent).sort().join(",") !== "compatibility,migration_notes,proposal" ||
          Object.keys(proposal).sort().join(",") !==
            "base_version,change,channels,github_prerelease,schema_version,source_commit,version" ||
          proposal.schema_version !== 1 ||
          proposal.source_commit !== active.source_commit ||
          proposal.version !== version ||
          proposal.base_version !== parsed.base_version ||
          proposal.change !== parsed.change ||
          proposal.github_prerelease !== classified.github_prerelease ||
          !isDeepStrictEqual(proposal.channels, classified.channels) ||
          intent.compatibility !== parsed.compatibility ||
          intent.migration_notes !== (parsed.migration_notes ?? "")
        )
          throw new Error("frozen classification differs from the existing preparation intent");
        frozenControlsOpportunity = structuredClone(frozen);
        if (controls) {
          phase = "authenticated-controls-before";
          controlsBefore = controls.read(api, frozenControlsOpportunity);
        }
      }
    }
    const publishedVersions: string[] = [];
    const publishedSources: string[] = [];
    for (const release of initialReleases.filter((r) => !r.draft)) {
      if (!release.tag_name.startsWith("v")) {
        holds.add("published-version-identity-unknown");
        continue;
      }
      const published = classifyApplicationVersion(release.tag_name.slice(1)).version;
      if (publishedVersions.includes(published))
        throw new Error("published version has multiple release identities");
      publishedVersions.push(published);
      const ref = initialTags.find((r) => r.name === release.tag_name);
      if (!ref) {
        holds.add("published-tag-identity-unavailable");
        continue;
      }
      const publishedCommit = peelReleaseReference(ref);
      const allocation = allocations.find(
        (a) => a.prepared_commit === publishedCommit && a.version === published,
      );
      if (!allocation) {
        holds.add("historical-original-source-and-routine-preview-classification-unresolved");
        continue;
      }
      publishedSources.push(allocation.source_commit);
      // Preparation intent does not authenticate whether publication was routine
      // or urgent. A mutable Release timestamp/title cannot supply that history.
      holds.add("routine-preview-publication-history-unresolved");
    }
    const reservedVersions = allocations
      .filter((a) => !publishedVersions.includes(a.version))
      .map((a) => a.version)
      .sort();
    if (reservedVersions.length !== 1 || reservedVersions[0] !== version)
      holds.add("complete-reservation-inventory-conflicts-with-active-candidate");
    phase = "qualification";
    const workflow = await readFile(path.join(project, ".github/workflows/release.yml"));
    const evidenceRequest = {
      schema_version: 1,
      repository_id: 1354613114,
      run_id: candidate.release_run.run_id,
      attempt: candidate.release_run.attempt,
      revision: active.prepared_commit,
      tree: active.prepared_tree,
      workflow_sha256: hash(workflow),
    };
    const evidence = collectReleaseRunEvidence(evidenceRequest, { api });
    if (
      evidence.run.conclusion !== "success" ||
      evidence.jobs.some((job) => !["success", "skipped"].includes(job.conclusion ?? ""))
    )
      holds.add("Release-attempt-has-required-failure-or-unknown-jobs");
    const required = requiredContextsFromConfigs(
      JSON.parse(await readFile(path.join(project, ".github/repository-ruleset.json"), "utf8")),
      JSON.parse(await readFile(path.join(project, ".github/qualification-coverage.json"), "utf8")),
    );
    const checkApi = {
      ...api,
      request: (method: string, endpoint: string, body?: unknown) => {
        const response = api.request(method, endpoint, body);
        const url = new URL(
          endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
        );
        if (url.pathname.endsWith("/check-runs")) {
          const runs = record(response.body).check_runs;
          if (!Array.isArray(runs)) throw new Error("qualification check inventory missing");
          for (const raw of runs) {
            const run = record(raw);
            if (run.head_sha !== active.prepared_commit)
              throw new Error("qualification check source differs");
            if (required.includes(String(run.name)) && record(run.app).id !== 15368)
              throw new Error("required qualification check issuer differs");
          }
        } else if (
          url.pathname.endsWith("/status") &&
          record(response.body).sha !== active.prepared_commit
        )
          throw new Error("qualification status source differs");
        return response;
      },
    };
    const delivery = new PullRequestDeliveryClient({
      ...checkApi,
      paginateRest: (endpoint, options) =>
        GitHubApiClient.prototype.paginateRest.call(checkApi, endpoint, options),
    });
    const readQualification = () =>
      requiredCheckContexts(
        delivery.checkRuns(active.prepared_commit),
        delivery.commitStatuses(active.prepared_commit),
        required,
      );
    const contexts = readQualification();
    if (contexts.some((context) => context.outcome !== "success" || context.source !== "check-run"))
      holds.add("exact-prepared-head-required-contexts-not-successful");
    const policy = selectReleasePackagePolicy(
      await loadPackagePolicy(project),
      config.release_profile,
    );
    const labels = releaseLabels(policy);
    const archives: { platform: string; artifact_id: number; bytes: number; sha256: string }[] = [];
    for (const platform of labels) {
      const matches = evidence.artifacts.filter(
        (a) =>
          a.name ===
          releaseBuildArtifactName(
            platform,
            String(evidenceRequest.run_id),
            evidenceRequest.attempt,
          ),
      );
      const artifact = matches[0];
      if (
        matches.length !== 1 ||
        !artifact ||
        artifact.expired ||
        !artifact.archive_sha256 ||
        artifact.bytes < 22 ||
        artifact.bytes > 512 * 1024 * 1024
      )
        throw new Error("complete immutable platform archive identity is unavailable");
      archives.push({
        platform,
        artifact_id: artifact.id,
        bytes: artifact.bytes,
        sha256: artifact.archive_sha256,
      });
    }
    if (archives.reduce((sum, a) => sum + a.bytes, 0) > 2 * 1024 * 1024 * 1024)
      throw new Error("admission archive matrix exceeds total bytes");
    phase = "archive-acquisition";
    const files = [];
    const declarations = [];
    const cliPackages = new Map<string, Buffer>();
    for (const archive of archives) {
      if (performance.now() - started > 15 * 60 * 1000)
        throw new Error("admission archive acquisition deadline exhausted");
      const bytes = (options.download ?? readGitHubArtifactArchive)(
        `${base}/actions/artifacts/${archive.artifact_id}/zip`,
        { cwd: root, maxBytes: archive.bytes, timeoutMs: 120000 },
      );
      const discovered = await discoverReleaseArtifactFiles(
        bytes,
        { bytes: archive.bytes, sha256: archive.sha256 },
        archive.platform,
        {
          version,
          run_id: String(evidenceRequest.run_id),
          run_attempt: evidenceRequest.attempt,
          source_commit: active.prepared_commit,
        },
        {
          ...(options.retainDesktopPackage
            ? { retainDesktopPackage: options.retainDesktopPackage }
            : {}),
          ...(options.compiler
            ? {
                retainCliPackage: async (identity, bytes) => {
                  cliPackages.set(identity.filename, bytes);
                },
              }
            : {}),
        },
      );
      files.push(...discovered.files);
      declarations.push(discovered.declared_producer);
    }
    phase = "public-build-input-acquisition";
    const publicBinding = config.public_build_inputs
      ? selectPublicBuildInputBinding(config.public_build_inputs, evidence)
      : null;
    const publicBuildInputs = publicBinding
      ? await verifyReleasePublicBuildInputs(root, publicBinding, evidence, {
          download: options.download,
        })
      : null;
    if (config.release_profile === "initial-beta-win-linux" && !publicBinding)
      holds.add("ratified-public-build-inputs-unavailable");
    if (
      publicBinding?.artifacts.some((item) =>
        archives.some((archive) => archive.artifact_id === item.artifact_id),
      )
    )
      throw new Error("public build inputs cannot reuse package artifact identities");
    const assembly = {
      schema_version: publicBinding ? 3 : 2,
      ...(publicBinding ? { public_build_inputs: publicBinding } : {}),
      release_profile: config.release_profile,
      source_commit: active.prepared_commit,
      source_tree: active.prepared_tree,
      version,
      run_id: String(evidenceRequest.run_id),
      run_attempt: evidenceRequest.attempt,
      files,
    };
    await inspectTrustedAssemblyInput(assembly);
    phase = "actual-compiler-source-and-output-acquisition";
    let compilerEvidence: Awaited<ReturnType<typeof collectReleaseCompilerEvidence>> | null = null;
    if (options.compiler && publicBuildInputs) {
      if (options.api || options.recover || options.download || options.now)
        throw new Error("actual compiler acceptance cannot use injected admission sources");
      const sourceBinding = await compareVerifiedReleaseCompilerSource(
        options.compiler.controller_tools,
        {
          source_commit: active.source_commit,
          source_tree: active.source_tree,
          prepared_commit: active.prepared_commit,
          prepared_tree: active.prepared_tree,
          version,
        },
        options.compiler.controller_source,
      );
      compilerEvidence = await collectReleaseCompilerEvidence(
        root,
        assembly,
        evidence,
        publicBuildInputs,
        cliPackages,
        sourceBinding,
        { preparedNamespace: config.namespace },
      );
      if (
        compilerEvidence.state === "verified-compiler-output-bindings" &&
        compilerEvidence.evidence_scope === "github.com"
      ) {
        await requireVerifiedReleaseCompilerEvidence(compilerEvidence);
      }
    }
    cliPackages.clear();
    phase = "signed-SBOM-document-acquisition";
    const sbomEvidence = await collectReleaseSbomEvidence(root, assembly, evidence, {
      download: options.download,
      preparedNamespace: config.namespace,
      maximumArchiveBytes: Math.min(
        512 * 1024 * 1024,
        2 * 1024 * 1024 * 1024 -
          archives.reduce((sum, item) => sum + item.bytes, 0) -
          (compilerEvidence?.state === "verified-compiler-output-bindings"
            ? compilerEvidence.archive_bytes
            : 0) -
          (publicBinding?.artifacts.reduce((sum, item) => sum + item.bytes, 0) ?? 0),
      ),
    });
    if (options.establishControls || options.establishNative) {
      if (!frozenControlsOpportunity)
        throw new Error("late control acquisition requires the actual frozen complete opportunity");
      phase = "private-facts-ready-awaiting-fresh-observer";
      if (!checkpoint) throw new Error("private prepared facts lack exact checkpoint");
      const facts: PreparedReleaseAdmissionFacts = {
        checkpoint,
        configuration: config,
        opportunity: frozenControlsOpportunity,
        assembly,
        archives,
        public_build_inputs: publicBuildInputs?.binding ?? null,
        evidence,
        contexts,
        allocations,
        compiler_evidence: compilerEvidence,
      };
      if (options.establishNative) {
        phase = "actual-stage-native-qualification";
        nativeReceipts = Object.freeze([
          ...(await options.establishNative(freezePreparedFacts(structuredClone(facts)))),
        ]);
        nativeReports = await requireNativeReleaseQualificationPair(
          nativeReceipts,
          assembly,
          archives,
          nativeStage,
        );
        facts.native_evidence = nativeReports.map((report) => ({
          check_id: report.check.id,
          report_sha256: report.check.report_sha256,
          stage: report.stage,
        }));
      }
      if (options.establishControls) {
        controls = await options.establishControls(
          hash(JSON.stringify(facts)),
          freezePreparedFacts(structuredClone(facts)),
        );
        requireAuthenticatedReleaseControlSource(controls, controlPhase);
        phase = "authenticated-controls-before-final-readback";
        controlsBefore = controls.read(api, frozenControlsOpportunity);
      }
    }
    phase = "freshness-bracket";
    const afterEvidence = collectReleaseRunEvidence(evidenceRequest, { api });
    if (publicBinding)
      requireStablePublicBuildInputEvidence(publicBinding, evidence, afterEvidence);
    if (
      !isDeepStrictEqual(evidence.run, afterEvidence.run) ||
      !isDeepStrictEqual(evidence.jobs, afterEvidence.jobs) ||
      !isDeepStrictEqual(evidence.artifacts, afterEvidence.artifacts)
    )
      throw new Error(
        "Release run, jobs or complete artifact inventory changed during acquisition",
      );
    if (!isDeepStrictEqual(contexts, readQualification()))
      throw new Error("required qualification changed during acquisition");
    if (!isDeepStrictEqual(initialTags, tags()) || !isDeepStrictEqual(initialReleases, releases()))
      throw new Error("publication or complete reservation snapshot changed");
    const after = record(await recover());
    if (after.checkpoint !== checkpoint)
      throw new Error("coordinator checkpoint changed during admission");
    if (controls && controlsBefore) {
      phase = "authenticated-controls-after";
      controlsAfter = controls.read(api, frozenControlsOpportunity);
      if (controlsBefore.facts_sha256 !== controlsAfter.facts_sha256)
        throw new Error("authenticated control inputs changed during admission");
    }
    // The retained snapshot's classification/pause/capacity fields are supplied
    // facts, not independent live authority. Do not feed them to an executing
    // plan or adopt a package's own checksum as acceptance.

    const capacityInput = {
      schema_version: 1,
      prior_operations:
        state.schema_version === 2 &&
        isRecord(state.controller) &&
        isRecord(state.controller.capacity_attempt)
          ? state.controller.capacity_attempt.prior_operations
          : [],
      ratification:
        controlsBefore?.capacity_source.capacity &&
        isRecord(controlsBefore.capacity_source.capacity)
          ? controlsBefore.capacity_source.capacity.ratification
          : (capacitySource?.ratification ?? {
              active: false,
              boundary_sha256: "0".repeat(64),
              resource_policy_sha256: slice4CapacityResourceDigest,
              selection: "slice4-d2-c6470ec28ba9addb0f70d9f86953322d835bb8c0",
            }),
      boundary: null as unknown,
      operation:
        isRecord(state.controller) && isRecord(state.controller.capacity_attempt)
          ? state.controller.capacity_attempt.operation
          : null,
    };
    try {
      const boundary = capacitySource ? structuredClone(await capacitySource.readBoundary()) : null;
      if (capacityBefore !== null && capacityDigest(capacityBefore) === capacityDigest(boundary))
        capacityInput.boundary = boundary;
    } catch {
      /* unavailable provider source never supplies eligibility */
    }
    if (controlsBefore && controlsAfter && isRecord(controlsAfter.capacity_source.capacity)) {
      capacityInput.boundary = controlsAfter.resource_policy_matches_controller
        ? controlsAfter.capacity_source.capacity.boundary
        : null;
      if (!controlsAfter.resource_policy_matches_controller)
        holds.add("current-controller-workflow-differs-from-ratified-capacity-resource-policy");
    }
    let capacity;
    try {
      capacity = assessBoundedCapacity(capacityInput);
    } catch {
      capacityInput.boundary = null;
      capacityInput.ratification = {
        active: false,
        boundary_sha256: "0".repeat(64),
        resource_policy_sha256: slice4CapacityResourceDigest,
        selection: "slice4-d2-c6470ec28ba9addb0f70d9f86953322d835bb8c0",
      };
      capacity = assessBoundedCapacity(capacityInput);
    }
    if (!capacitySource && !controlsBefore)
      holds.add("admitted-spending-boundary-source-unconfigured");
    if (capacity.eligibility !== "eligible") holds.add("bounded-no-spend-attempt-ineligible");
    if (!controlsBefore || !controlsAfter)
      holds.add(
        options.controls
          ? "independent-controls-not-bound-to-active-frozen-opportunity"
          : "independent-classification-and-pause-sources-unconfigured",
      );
    else if (controlsAfter.pause.publication_paused)
      holds.add("publication-paused-by-owner-source");
    if (
      !compilerEvidence ||
      compilerEvidence.state !== "verified-compiler-output-bindings" ||
      compilerEvidence.evidence_scope !== "github.com"
    )
      holds.add("candidate-workflow-execution-and-producer-acceptance-unproven");
    else await requireVerifiedReleaseCompilerEvidence(compilerEvidence);
    // The existing attester authenticates the exact SPDX document and package
    // subjects. It cannot substitute for the compiler or a native journey.
    if (
      sbomEvidence.state !== "verified-document" ||
      sbomEvidence.evidence_scope !== "github.com" ||
      options.api ||
      options.recover ||
      options.download ||
      options.now
    )
      holds.add("strict-release-SBOM-document-unverified");
    if (!nativeReceipts || !nativeReports)
      holds.add("strict-release-native-authorization-not-evaluated");
    else {
      phase = "actual-stage-native-final-readback";
      nativeReports = await requireNativeReleaseQualificationPair(
        nativeReceipts,
        assembly,
        archives,
        nativeStage,
      );
    }
    // The post-sign journey must also join the actual signed context/records,
    // not just a report's declared digest. The private context consumer owns
    // that remaining connection; native observations alone cannot clear it.
    if (nativeStage === "release-publication")
      holds.add("authenticated-signed-context-qualification-unavailable");
    const publication = {
      complete: publishedSources.length === publishedVersions.length,
      observed_at: new Date((options.now ?? Date.now)()).toISOString(),
      published_versions: publishedVersions.sort(),
      published_sources: [...new Set(publishedSources)].sort(),
      reserved_versions: reservedVersions,
      last_routine_preview_at: null,
    };
    // Exercise the existing planner's schema/active-state path only behind a
    // conservative hold. This diagnostic plan has no acquired control authority.
    const diagnosticPlan =
      publication.complete && initialReleases.every((r) => r.draft)
        ? planReleaseOpportunity({
            ...state,
            schema_version: 2,
            now: publication.observed_at,
            publication,
            controller: {
              workflow: record(state.controller).workflow,
              revision: record(state.controller).revision,
              publication_paused: true,
              capacity_attempt: capacityInput,
            },
          })
        : null;
    const evidenceScope =
      options.api ||
      options.recover ||
      options.download ||
      options.now ||
      options.capacity ||
      (controls?.evidence_scope !== undefined && controls.evidence_scope !== "github.com")
        ? "injected-provider"
        : "github.com";
    const result = {
      schema_version: 1,
      decision:
        holds.size === 0 && nativeReports && evidenceScope === "github.com"
          ? qualifyingOnly
            ? "eligible-for-candidate-building"
            : nativeStage === "payload-signing"
              ? "eligible-for-payload-signing"
              : "admitted"
          : "hold",
      stage: qualifyingOnly ? "candidate-building" : nativeStage,
      descriptor: null,
      directory: root,
      checkpoint,
      holds: [...holds].sort(),
      capacity,
      controls: controlsAfter,
      publication,
      allocations,
      contexts,
      source_changes: sourceChanges,
      evidence,
      assembly,
      archives,
      public_build_inputs: publicBuildInputs,
      declared_producers: declarations,
      sbom_evidence: sbomEvidence,
      compiler_evidence: compilerEvidence,
      native_evidence:
        nativeReports?.map((report) => ({
          check_id: report.check.id,
          stage: report.stage,
          report_sha256: report.check.report_sha256,
          candidate: report.candidate,
          producer: report.producer,
        })) ?? null,
      pending_obligations:
        nativeStage === "payload-signing"
          ? [
              "post-sign-native-compatible-update-rollback-journal",
              "post-publication-full-public-V0-to-V1-acceptance",
            ]
          : ["post-publication-full-public-V0-to-V1-acceptance"],
      diagnostic_plan: diagnosticPlan,
      diagnostic_plan_scope: "conservative paused schema check only; no acquired control authority",
      api_requests: requests,
      evidence_scope: evidenceScope,
      authority: "none",
    };
    if (result.evidence_scope === "github.com" && sbomEvidence.state === "verified-document") {
      await requireVerifiedReleaseSbomDocument(sbomEvidence);
      acquiredSbomReceipts.set(result, sbomEvidence);
      if (publicBuildInputs) {
        await requireVerifiedReleasePublicBuildInputs(publicBuildInputs);
        acquiredPublicInputReceipts.set(result, publicBuildInputs);
      }
      if (nativeReceipts && nativeReports) acquiredNativeReceipts.set(result, nativeReceipts);
      if (
        typeof before.repository === "string" &&
        path.isAbsolute(before.repository) &&
        /^coordinator-recovery-[A-Za-z0-9]+$/u.test(path.relative(root, before.repository))
      ) {
        acquiredCoordinatorRepositories.set(result, before.repository);
        acquiredCandidates.set(result, freezePreparedFacts(structuredClone(candidate)));
      }
    }
    return result;
  } catch {
    const evidence = {
      schema_version: 1,
      decision: "refused",
      directory: root,
      checkpoint,
      phase,
      api_requests: requests,
      authority: "none",
    };
    // Only our own bounded fields cross this boundary. Provider errors can
    // contain bearer material, arbitrary candidate text or transport commands.
    try {
      await writeFile(path.join(root, "admission-failure.json"), JSON.stringify(evidence), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // A storage failure must still return the owned location to the caller;
      // the CLI can retain that bounded evidence in its outer result receipt.
    }
    throw new CoordinatorRemoteError(`release admission refused during ${phase}`, evidence);
  }
}

/** The existing one-process handshake, shared with later fixed controller roles.
 * An optional trusted continuation finishes additional immutable byte work
 * before readiness; it receives only a detached frozen view, never authority. */
async function performAdmissionHandshake(
  root: string,
  configuration: unknown,
  rawPhase: unknown = "admission",
  additionalFacts?: (
    facts: Readonly<PreparedReleaseAdmissionFacts>,
    factsSha256: string,
  ) => Promise<string>,
  onAdmitted?: (context: Readonly<ActualReleaseAdmissionContext>) => Promise<void>,
  compiler?: ReleaseCompilerAdmissionPrerequisite,
  establishNative?: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]>["establishNative"],
  building?: { tools: object; namespace: string; receive: (proof: object) => Promise<void> },
  deadline?: number,
  publicationCompletion = false,
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  const env = { ...process.env };
  const workflow = await readProductionControllerWorkflowBytes();
  const reader = await authenticateControlReaderJob(env, workflow, {
    phase,
    ...(deadline === undefined ? {} : { deadline }),
  });
  if (building) {
    const tools = await verifiedControllerToolPaths(building.tools);
    if (
      tools.identity.controller_revision !== reader.admitted.revision ||
      tools.identity.controller_ref !== reader.admitted.execution_ref ||
      tools.identity.run_id !== String(reader.admitted.run_id) ||
      tools.identity.run_attempt !== reader.admitted.run_attempt
    )
      throw new Error("qualifying reader and actual controller tools differ");
  }
  const retained: {
    facts: Readonly<PreparedReleaseAdmissionFacts> | null;
    controls: AuthenticatedReleaseControlSource | null;
  } = { facts: null, controls: null };
  const collection: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]> = {
    ...(compiler ? { compiler } : {}),
    ...(establishNative ? { establishNative } : {}),
    controlPhase: phase,
    establishControls: async (factsSha256, facts) => {
      retained.facts = facts;
      const readyDigest = additionalFacts ? await additionalFacts(facts, factsSha256) : factsSha256;
      if (!/^[a-f0-9]{64}$/u.test(readyDigest))
        throw new Error("prepared continuation requires its exact facts digest");
      await writeFile(
        path.join(root, `ready-${phase}.json`),
        JSON.stringify(prepareControlReadiness(reader.identity, readyDigest, phase)),
        { flag: "wx", mode: 0o600 },
      );
      const observedArtifact = await waitForControlArtifact(
        root,
        "observation",
        {
          phase,
          controller_revision: reader.admitted.revision,
          controller_ref: reader.admitted.execution_ref,
          run_id: String(reader.admitted.run_id),
          run_attempt: reader.admitted.run_attempt,
        },
        deadline === undefined ? {} : { phaseDeadline: deadline },
      );
      retained.controls = await authenticateReleaseControlSource(env, workflow, {
        phase,
        observedArtifact,
        ...(deadline === undefined ? {} : { deadline }),
      });
      return retained.controls;
    },
  };
  if (building) {
    if (phase !== "admission" || onAdmitted)
      throw new Error("building eligibility is separate from payload/publication admission");
    qualifyingCollections.add(collection);
  }
  if (publicationCompletion) {
    if (phase !== "release-publication" || building || !onAdmitted || !compiler || !establishNative)
      throw new Error("fixed publication completion prerequisites unavailable");
    publicationCompletionCollections.add(collection);
  }
  const admission = await acquireReleaseAdmission(root, configuration, collection);
  // Native stage qualification is necessary but cannot clear unrelated holds.
  // Only this actual acquisition process can create the corresponding private
  // continuation; no JSON/injected descriptor appoints an execution stage.
  if (
    (onAdmitted || building) &&
    ["admitted", "eligible-for-payload-signing", "eligible-for-candidate-building"].includes(
      admission.decision,
    ) &&
    admission.holds.length === 0
  ) {
    const { facts, controls } = retained;
    if (
      admission.evidence_scope !== "github.com" ||
      !admission.controls ||
      !facts ||
      !controls ||
      controls.evidence_scope !== "github.com" ||
      facts.checkpoint !== admission.checkpoint
    )
      throw new Error(
        "positive continuation requires actual same-process facts/control/reservation binding",
      );
    requireAuthenticatedReleaseControlSource(controls, phase);
    const sbomReceipt = acquiredSbomReceipts.get(admission);
    if (!sbomReceipt) throw new Error("positive continuation requires actual signed SPDX custody");
    await requireVerifiedReleaseSbomDocument(sbomReceipt);
    if (building ? phase !== "admission" : phase !== "payload" && phase !== "release-publication")
      throw new Error("actual admission context cannot appoint another execution stage");
    const stage = inspectAdmissionNativeStage(phase, admission.stage);
    const nativeReceipts = acquiredNativeReceipts.get(admission);
    if (!nativeReceipts) throw new Error("positive continuation requires actual native custody");
    await requireNativeReleaseQualificationPair(
      nativeReceipts,
      facts.assembly,
      facts.archives,
      stage,
    );
    const coordinatorRepository = acquiredCoordinatorRepositories.get(admission);
    if (!coordinatorRepository)
      throw new Error(
        "positive continuation requires actual privately recovered coordinator repository",
      );
    const publicInputs = acquiredPublicInputReceipts.get(admission);
    if (!publicInputs)
      throw new Error("positive continuation requires actual public root/key custody");
    await requireVerifiedReleasePublicBuildInputs(publicInputs);
    if (building) {
      if (phase !== "admission" || admission.decision !== "eligible-for-candidate-building")
        throw new Error("actual qualifying eligibility target differs");
      const candidate = acquiredCandidates.get(admission);
      if (!candidate || candidate.phase !== "qualifying")
        throw new Error("actual qualifying candidate custody missing");
      const proof = Object.freeze({
        kind: "actual-candidate-building-eligibility",
        checkpoint: admission.checkpoint,
        authority: "none",
      });
      actualBuildingEligibility.set(proof, {
        stage: "candidate-building",
        repository: coordinatorRepository,
        checkpoint: admission.checkpoint,
        candidate,
        facts,
        controls,
        admission: freezePreparedFacts(structuredClone(admission)),
        reader: freezePreparedFacts(structuredClone(reader)),
        namespace: building.namespace,
        controller_tools: building.tools,
        native_qualifications: nativeReceipts,
        sbom_receipt: sbomReceipt,
        public_build_inputs_receipt: publicInputs,
        pending_obligations: Object.freeze([
          "actual-aggregate-and-payload-eligibility-still-required",
          ...admission.pending_obligations,
        ]),
      });
      await building.receive(proof);
      return admission;
    }
    const context = Object.freeze({
      stage,
      facts,
      controls,
      admission: freezePreparedFacts(structuredClone(admission)),
      checkpoint: admission.checkpoint,
      native_qualifications: nativeReceipts,
      coordinator_repository: coordinatorRepository,
      sbom_receipt: sbomReceipt,
      public_build_inputs_receipt: publicInputs,
      pending_obligations: Object.freeze([...admission.pending_obligations]),
    });
    const candidate = acquiredCandidates.get(admission);
    if (publicationCompletion && candidate?.phase === "promoting")
      actualPublicationCompletionContexts.set(context, context);
    else actualAdmissionContexts.set(context, { context, phase });
    await onAdmitted!(context);
  }
  return admission;
}

/** Existing payload/publication entry retains its exact phase restrictions. */
export function acquireReleaseAdmissionWithControlHandshake(
  root: string,
  configuration: unknown,
  rawPhase: unknown = "admission",
  additionalFacts?: (
    facts: Readonly<PreparedReleaseAdmissionFacts>,
    factsSha256: string,
  ) => Promise<string>,
  onAdmitted?: (context: Readonly<ActualReleaseAdmissionContext>) => Promise<void>,
  compiler?: ReleaseCompilerAdmissionPrerequisite,
  establishNative?: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]>["establishNative"],
  deadline?: number,
) {
  return performAdmissionHandshake(
    root,
    configuration,
    rawPhase,
    additionalFacts,
    onAdmitted,
    compiler,
    establishNative,
    undefined,
    deadline,
  );
}

/** Fixed Release caller only. Promoting acquisition yields the distinct
 * readback-only brand above, never a publication/signing/aggregate capability. */
export function acquirePublicationControllerAdmission(
  root: string,
  configuration: unknown,
  onAdmitted: NonNullable<Parameters<typeof acquireReleaseAdmissionWithControlHandshake>[4]>,
  compiler: ReleaseCompilerAdmissionPrerequisite,
  establishNative: NonNullable<Parameters<typeof acquireReleaseAdmission>[2]>["establishNative"],
  deadline: number,
) {
  return performAdmissionHandshake(
    root,
    configuration,
    "release-publication",
    undefined,
    onAdmitted,
    compiler,
    establishNative,
    undefined,
    deadline,
    true,
  );
}

/** Read-only qualifying evidence under the fixed independent reader. It neither
 * advances the candidate nor creates payload/publication admission. */
export async function acquireActualCandidateBuildingEligibility(
  root: string,
  rawConfiguration: unknown,
  controllerTools: object,
  rawNativeLocators: unknown,
) {
  const capturedConfiguration: unknown = structuredClone(rawConfiguration),
    nativeLocators: unknown = structuredClone(rawNativeLocators);
  const tools = await verifiedControllerToolPaths(controllerTools);
  const authorities = await requireControllerReleaseAuthorities("admission");
  const configured = configuration(capturedConfiguration);
  if (
    configured.namespace !== authorities.namespace ||
    configured.release_profile !== "initial-beta-win-linux"
  )
    throw new Error(
      "qualifying source requires the actual ratified namespace and selected package profile",
    );
  const closure = inspectReleaseCompilerSourceClosure(
    JSON.parse(
      (await readControllerToolFile(tools.compiler_source_closure, 65536)).toString("utf8"),
    ),
  );
  if (
    closure.source_commit !== tools.identity.controller_revision ||
    closure.source_tree !== tools.identity.source_tree
  )
    throw new Error("qualifying compiler closure differs from authenticated tools");
  let proof: object | undefined;
  const admission = await performAdmissionHandshake(
    root,
    capturedConfiguration,
    "admission",
    undefined,
    undefined,
    {
      controller_tools: controllerTools,
      controller_source: { source_commit: closure.source_commit, source_tree: closure.source_tree },
    },
    (facts) =>
      collectConfiguredNativeReleaseQualificationPair(
        root,
        nativeLocators,
        facts.assembly,
        facts.archives,
        "admission",
      ),
    {
      tools: controllerTools,
      namespace: authorities.namespace,
      receive: async (actual) => {
        proof = actual;
      },
    },
  );
  return (
    proof ??
    Object.freeze({
      kind: "candidate-building-eligibility-unavailable",
      decision: "hold",
      admission,
      authority: "none",
    })
  );
}

/** Exact private proof for the separate durable phase writer. A caller cannot
 * import a successful report, change a hold or reinterpret payload admission. */
export async function requireActualCandidateBuildingEligibility(receipt: object) {
  const actual = actualBuildingEligibility.get(receipt);
  if (!actual) throw new Error("actual same-process candidate building eligibility required");
  requireAuthenticatedReleaseControlSource(actual.controls, "admission");
  await verifiedControllerToolPaths(actual.controller_tools);
  await requireNativeReleaseQualificationPair(
    actual.native_qualifications,
    actual.facts.assembly,
    actual.facts.archives,
    "payload-signing",
  );
  await requireVerifiedReleaseSbomDocument(actual.sbom_receipt);
  await requireVerifiedReleasePublicBuildInputs(actual.public_build_inputs_receipt);
  requireAuthenticatedReleaseControlSource(actual.controls, "admission");
  return Object.freeze({
    ...actual,
    candidate: freezePreparedFacts(structuredClone(actual.candidate)),
  });
}

async function main() {
  const handshake = process.argv.length === 3 && process.argv[2] === "--handshake";
  if (process.argv.length !== 2 && !handshake)
    throw new Error("admission accepts no candidate path or dispatch arguments");
  const raw = process.env.PORTCOVE_COORDINATOR_CONFIGURATION;
  if (!raw || Buffer.byteLength(raw) > 4096)
    throw new Error("ratified coordinator configuration unavailable");
  const root = process.env.RUNNER_TEMP;
  if (!root || !path.isAbsolute(root)) throw new Error("private runner root unavailable");
  await retainAggregateStepReceipt(
    path.join(root, "release-admission-control-receipt.jsonl"),
    {
      operation: "independent-admission",
      checkpoint: "unresolved",
      descriptor_sha256: hash(raw),
    },
    async (stage) => {
      stage("acquire-publication-reservation-and-qualification");
      let result;
      try {
        if (handshake) {
          result = await acquireReleaseAdmissionWithControlHandshake(root, JSON.parse(raw));
        } else {
          const workflow = await readProductionControllerWorkflowBytes();
          const controls = await authenticateReleaseControlSource(process.env, workflow);
          result = await acquireReleaseAdmission(root, JSON.parse(raw), { controls });
        }
      } catch (error) {
        if (error instanceof CoordinatorRemoteError)
          await writeFile(
            path.join(root, "release-admission-result.json"),
            JSON.stringify(error.evidence),
            {
              flag: "wx",
              mode: 0o600,
            },
          );
        throw error;
      }
      const bytes = JSON.stringify(result);
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
        throw new Error("admission diagnostic evidence exceeds bound");
      await writeFile(path.join(root, "release-admission-result.json"), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          decision: result.decision,
          checkpoint: result.checkpoint,
          holds: result.holds,
          authority: result.authority,
        }),
      );
    },
  );
  process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    console.error(
      "independent release admission refused; retain owned acquisition evidence; no descriptor or mutation emitted",
    );
    process.exitCode = 2;
  });
  if (process.argv[2] === "--handshake" && process.env.RUNNER_TEMP)
    await writeFile(
      path.join(process.env.RUNNER_TEMP, "release-admission-process-ended.json"),
      JSON.stringify({ exit_code: process.exitCode ?? 0, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {
      process.exitCode = 2;
    });
}
