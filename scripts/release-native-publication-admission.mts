/** Actual fixed post-sign reader. Context/role/provider persistence is custody,
 * not native acceptance. Only the existing current native consumer mints that
 * private qualification after all independently expected inputs match. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  requireControllerNativePrepublicationAuthorities,
  inspectPublicationAuthorities,
} from "./release-authority-configuration.mts";
import { requireActualTufPublication } from "./release-tuf-publication.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { requireReceivedSigningContext } from "./release-signing-context-artifact.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import {
  requireReservedAggregate,
  inspectReservedPublicationReadback,
} from "./production-aggregate-steps.mts";
import {
  inspectMetadataBootstrapDescriptor,
  inspectPublishedMetadata,
} from "./release-metadata-contract.mts";
import { inspectCompactCapacityOperations } from "./release-capacity.mts";
import {
  deriveNativeQualificationExpectations,
  collectNativeReleaseQualificationPair,
} from "./release-native-admission.mts";
import { inspectNativeQualificationExpectation } from "./release-native-acceptance.mts";
import {
  inspectNativeReleaseQualification,
  inspectNativeQualificationCandidate,
  nativeEmptyRecordsSha256,
  nativePrepublicationProfile,
} from "./release-native-qualification-contract.mts";
import {
  createReleasePublicationReader,
  peelReleaseReference,
} from "./release-publication-inventory.mts";
import { selectCoordinatorPublicationBaseline } from "./release-coordinator-driver.mts";
import { inspectPublishedApplicationSource } from "./release-published-source.mts";
import { isRecord } from "./runtime-values.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inventory = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));

/** Historical attribution only: an already Tough-authenticated immutable record
 * pins the exact old report digest, so no current issuer/host is inferred from
 * that old Check. This function never authenticates a new native qualification. */
export function inspectNativePublicationPredecessor(rawRecord: unknown, rawCheck: unknown) {
  const record: unknown = structuredClone(rawRecord),
    check: unknown = structuredClone(rawCheck);
  if (
    !isRecord(record) ||
    !isRecord(record.artifact) ||
    !isRecord(record.qualified_run) ||
    !Array.isArray(record.evidence_ids) ||
    !isRecord(check) ||
    !isRecord(check.output) ||
    typeof check.output.summary !== "string" ||
    Buffer.byteLength(check.output.summary) > 65536
  )
    throw new Error("authenticated prior native attribution missing");
  const references = record.evidence_ids.filter(
    (entry: unknown) =>
      typeof entry === "string" && /^native-check:[1-9][0-9]*:[a-f0-9]{64}$/u.test(entry),
  );
  if (references.length !== 1 || typeof references[0] !== "string")
    throw new Error("exact historical native reference required");
  const [, id, reportSha] = references[0].split(":");
  const summary: unknown = JSON.parse(check.output.summary);
  if (
    !isRecord(summary) ||
    Object.keys(summary).sort().join(",") !== "report,report_sha256,schema_version"
  )
    throw new Error("historical native summary differs");
  const report = inspectNativeReleaseQualification(summary.report),
    candidate = report.candidate;
  if (
    check.id !== Number(id) ||
    check.head_sha !== record.source_commit ||
    summary.report_sha256 !== reportSha ||
    digest(report) !== reportSha ||
    summary.schema_version !== report.schema_version ||
    check.external_id !== `portcove-native-qualification-v${report.schema_version}:${reportSha}` ||
    candidate.source_commit !== record.source_commit ||
    candidate.source_tree !== record.source_tree ||
    candidate.run_id !== String(record.qualified_run.run_id) ||
    candidate.run_attempt !== record.qualified_run.attempt ||
    candidate.package.bytes !== record.artifact.bytes ||
    candidate.package.sha256 !== record.artifact.sha256 ||
    report.platform_label !== record.target ||
    typeof record.artifact.url !== "string" ||
    decodeURIComponent(new URL(record.artifact.url).pathname.split("/").at(-1) ?? "") !==
      candidate.package.filename
  )
    throw new Error("historical native report differs from authenticated prior record");
  return inspectNativeQualificationCandidate(candidate);
}

/** Exact data association only. The fixed caller must separately establish the
 * Tough-empty prior, current journal/provider state and ratified public pins. */
export function inspectNativeInitialPublicationJourney(raw: {
  bootstrap: unknown;
  published: unknown;
  capacity_groups: unknown;
  public_pins: unknown;
  payload_sha256: string;
  signed_context_sha256: string;
  signatures_sha256: string;
  prior_records_sha256: string;
  authority_schema_version?: unknown;
}) {
  const selected = structuredClone(raw);
  if (
    selected.authority_schema_version !== undefined &&
    selected.authority_schema_version !== 1 &&
    selected.authority_schema_version !== 2
  )
    throw new Error("native publication authority schema differs");
  const bootstrap = inspectMetadataBootstrapDescriptor(selected.bootstrap),
    published = inspectPublishedMetadata(selected.published),
    pins = inspectPublicationAuthorities(
      selected.public_pins,
      selected.authority_schema_version ?? 1,
    ),
    groups = inspectCompactCapacityOperations(selected.capacity_groups),
    bootstrapSha = digest(bootstrap);
  if (
    !published ||
    selected.prior_records_sha256 !== nativeEmptyRecordsSha256 ||
    published.records_sha256 !== nativeEmptyRecordsSha256 ||
    bootstrap.setup_plan_sha256 !== pins.setup_plan_sha256 ||
    bootstrap.initial_site_preimage_sha256 !== pins.initial_site_preimage_sha256 ||
    bootstrap.root_sha256 !== published.root_sha256 ||
    bootstrap.root_sha256 !== pins.public_source.root.sha256 ||
    bootstrap.offline_targets_sha256 !== published.offline_targets_sha256 ||
    bootstrap.offline_targets_sha256 !== pins.public_source.offline_targets.sha256 ||
    bootstrap.payload_key_registry_sha256 !== selected.payload_sha256 ||
    selected.payload_sha256 !== pins.public_source.payload_key_registry.sha256 ||
    !groups.some(
      (group) =>
        group.subject.kind === "metadata-bootstrap" &&
        group.subject.identity === bootstrapSha &&
        group.completed &&
        group.kind === "upload" &&
        group.destination_sha256 === digest("github-pages:boburning/portcove:complete-site") &&
        group.attempts.some((attempt) => attempt.id === published.operation_id),
    ) ||
    !/^[a-f0-9]{64}$/u.test(selected.signed_context_sha256) ||
    !/^[a-f0-9]{64}$/u.test(selected.signatures_sha256)
  )
    throw new Error("initial native branch lacks exact bootstrap/public/Tough-empty binding");
  return Object.freeze({
    kind: "initial-empty-feed" as const,
    metadata_bootstrap_sha256: bootstrapSha,
    setup_plan_sha256: bootstrap.setup_plan_sha256,
    initial_site_preimage_sha256: bootstrap.initial_site_preimage_sha256,
    empty_records_sha256: nativeEmptyRecordsSha256,
    signed_context_sha256: selected.signed_context_sha256,
    signatures_sha256: selected.signatures_sha256,
  });
}

/** The seven argument fixed entry deliberately cannot accept a journey,
 * expected-report JSON, caller trust boolean or injected provider. */
type NativePublicationPairArguments = [
  parent: string,
  locators: unknown,
  assembly: unknown,
  archives: unknown,
  context: object,
  tufPublication: object,
  deadline: number,
];
export function collectConfiguredNativePublicationQualificationPair(
  ...args: NativePublicationPairArguments
) {
  return collectNativePublicationPair("reserved", ...args);
}
/** The fixed promoting continuation only re-reads existing authenticated Checks.
 * It cannot admit an aggregate or obtain any completion/effect capability. */
export function collectConfiguredNativePublicationCompletionPair(
  ...args: NativePublicationPairArguments
) {
  return collectNativePublicationPair("completion-readback", ...args);
}
async function collectNativePublicationPair(
  purpose: "reserved" | "completion-readback",
  parent: string,
  rawLocators: unknown,
  rawAssembly: unknown,
  rawArchives: unknown,
  receivedContext: object,
  actualTufPublication: object,
  deadline: number,
) {
  const remaining = () => {
    const left = Math.floor(deadline - performance.now());
    if (!Number.isFinite(deadline) || left < 1)
      throw new Error("post-sign native phase deadline exhausted");
    return Math.min(left, 15000);
  };
  remaining();
  const locators: unknown = structuredClone(rawLocators),
    assembly: unknown = structuredClone(rawAssembly),
    archives: unknown = structuredClone(rawArchives);
  const tuf = await requireActualTufPublication(actualTufPublication, deadline);
  if (tuf.context_receipt !== receivedContext)
    throw new Error("post-sign native context differs from actual signed repository");
  const context = await requireReceivedSigningContext(receivedContext, deadline),
    manifest = context.manifest,
    authorities = await requireControllerNativePrepublicationAuthorities(),
    publicPins = inspectPublicationAuthorities(authorities.publication, authorities.schema_version);
  if (
    !isRecord(manifest.facts) ||
    !isRecord(manifest.facts.configuration) ||
    !isRecord(manifest.facts.opportunity) ||
    !isRecord(manifest.binding) ||
    manifest.facts.configuration.namespace !== authorities.namespace ||
    digest(manifest.facts.assembly) !== digest(assembly) ||
    digest(manifest.facts.archives) !== digest(archives)
  )
    throw new Error("post-sign native acquired candidate differs from authenticated context");
  const binding = manifest.binding;
  const signedContext = tuf.publication.repository_sha256;
  if (typeof signedContext !== "string")
    throw new Error("actual signed repository identity missing");
  const expectedBefore = await deriveNativeQualificationExpectations(
    authorities,
    locators,
    assembly,
    archives,
    "payload-signing",
  );
  const files = await readBoundedReleaseContextFiles(path.dirname(context.context));
  const required = (name: string) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error("post-sign native authenticated input missing");
    return bytes;
  };
  if (
    hash(required("trusted-root.json")) !== publicPins.public_source.root.sha256 ||
    hash(required("offline-targets.json")) !== publicPins.public_source.offline_targets.sha256 ||
    hash(required("payload.json")) !== publicPins.public_source.payload_key_registry.sha256
  )
    throw new Error("post-sign native public anchors differ from ratified setup");
  const prior = new Map(
    [...files]
      .filter(([name]) => name.startsWith("prior/") && name !== "prior/repository-manifest.json")
      .map(([name, bytes]) => [name.slice(6), bytes]),
  );
  const priorRecords = new Map<string, Record<string, unknown>>();
  for (const [name, bytes] of prior) {
    if (!name.startsWith("targets/")) continue;
    const match = /^targets\/([a-f0-9]{64})\.((?:releases|channels)\/.+\.json)$/u.exec(name);
    if (!match) continue;
    if (hash(bytes) !== match[1]) throw new Error("prior hashed target bytes differ");
    const record: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(record) || priorRecords.has(match[2]!))
      throw new Error("prior authenticated record inventory differs");
    priorRecords.set(match[2]!, record);
  }
  const directory = await mkdtemp(path.join(parent, "native-publication-inputs-"));
  let phase = "current-reservation";
  try {
    const snapshot = () =>
      readRemoteCoordinatorSnapshot(
        directory,
        { schema_version: 1, namespace: authorities.namespace },
        { transport: { cwd: directory, deadline } },
      );
    const before = await snapshot();
    const descriptor = JSON.stringify({
      schema_version: 1,
      checkpoint: before.checkpoint,
      coordinator: { schema_version: 1, namespace: authorities.namespace },
      assembly,
      archives,
      evidence: {},
    });
    const associate =
      purpose === "reserved" ? requireReservedAggregate : inspectReservedPublicationReadback;
    await associate(descriptor, before);
    if (
      !isRecord(before.input.active_candidate) ||
      digest(before.input.active_candidate.frozen_opportunity) !==
        digest(manifest.facts.opportunity)
    )
      throw new Error("post-sign native frozen opportunity changed");
    const published = inspectPublishedMetadata(before.input.published_metadata);
    if (
      !published ||
      !isRecord(manifest.previous_site_pins) ||
      published.repository_sha256 !== digest(inventory(prior)) ||
      published.repository_sha256 !== manifest.previous_site_pins.repository_sha256 ||
      published.root_sha256 !== manifest.previous_site_pins.root_sha256 ||
      published.publication.site_generation_sha256 !==
        manifest.previous_site_pins.site_generation_sha256
    )
      throw new Error("post-sign native prior differs from actual current published seed");
    await writeFile(
      path.join(directory, "reservation-before.json"),
      JSON.stringify({ checkpoint: before.checkpoint, published }),
      { flag: "wx", mode: 0o600 },
    );
    const runner = createGitHubRunner({
      cwd: directory,
      timeoutMs: 15000,
      maxBuffer: 1024 * 1024,
      spawn: (command, args, settings) =>
        spawnSync(command, args, {
          ...settings,
          timeout: remaining(),
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            GH_TOKEN: process.env.GH_TOKEN,
            GH_HOST: "github.com",
            HOME: directory,
            USERPROFILE: directory,
            GH_CONFIG_DIR: directory,
          },
        }),
    });
    const client = new GitHubApiClient((args, input) => {
      remaining();
      const result = runner([...args, "--hostname", "github.com"], input);
      remaining();
      return result;
    });
    let reads = 0;
    const api = {
      request: (method: string, endpoint: string, body?: unknown) => {
        if (method !== "GET" || body != null || ++reads > 160)
          throw new Error("post-sign native source is bounded GET only");
        remaining();
        const result = client.request(method, endpoint);
        remaining();
        return result;
      },
      graphql: (query: string, variables: Readonly<Record<string, unknown>>) => {
        if (++reads > 160) throw new Error("post-sign native read budget exhausted");
        remaining();
        const result = client.graphql(query, variables);
        remaining();
        return result;
      },
    };
    phase = "independent-native-journey";
    let journeys: unknown[];
    if (priorRecords.size === 0) {
      const controller = before.input.controller;
      if (
        !isRecord(controller) ||
        !isRecord(controller.capacity_attempt) ||
        controller.capacity_attempt.schema_version !== 2
      )
        throw new Error("initial native branch requires actual bounded bootstrap history");
      if (typeof binding.signatures_sha256 !== "string")
        throw new Error("actual payload signature binding missing");
      const journey = inspectNativeInitialPublicationJourney({
        bootstrap: before.input.metadata_bootstrap,
        published,
        capacity_groups: controller.capacity_attempt.prior_operations,
        public_pins: publicPins,
        authority_schema_version: authorities.schema_version,
        payload_sha256: hash(required("payload.json")),
        signed_context_sha256: signedContext,
        signatures_sha256: binding.signatures_sha256,
        prior_records_sha256: digest(inventory(priorRecords.size === 0 ? new Map() : prior)),
      });
      journeys = expectedBefore.map(() => journey);
    } else {
      const reader = createReleasePublicationReader(api),
        releases = reader.releases(),
        tags = reader.tags();
      const versions = [
        ...new Set(
          [...priorRecords.values()]
            .filter((record) => typeof record.version === "string" && record.artifact !== undefined)
            .map((record) => String(record.version)),
        ),
      ];
      // The authenticated current Tough seed defines predecessor eligibility.
      // A recovered invocation may already have published this candidate's
      // immutable Release while its Pages effect is still pending; that new
      // Release cannot become its own predecessor. All provider rows remain
      // bracketed, and publication admission separately verifies the full set.
      const baseline = selectCoordinatorPublicationBaseline(
          releases.filter((release) => versions.includes(release.tag_name.slice(1))),
          versions,
        ),
        tag = tags.find((item) => item.name === `v${baseline.version}`);
      if (!tag) throw new Error("actual publication baseline tag absent");
      const prepared = peelReleaseReference(tag),
        response = api.request("GET", `repos/boburning/portcove/git/commits/${prepared}`);
      if (
        response.status !== 200 ||
        !isRecord(response.body) ||
        !isRecord(response.body.tree) ||
        typeof response.body.tree.sha !== "string"
      )
        throw new Error("actual baseline source tree absent");
      const source = inspectPublishedApplicationSource(
        api,
        { schema_version: 1, namespace: authorities.namespace },
        {
          id: baseline.release.id,
          version: baseline.version,
          prepared_commit: prepared,
          prepared_tree: response.body.tree.sha,
        },
      );
      if (source.source_baseline.commit !== manifest.facts.opportunity.base_commit)
        throw new Error(
          "native predecessor differs from independently established publication baseline",
        );
      journeys = expectedBefore.map((expected) => {
        const records = [...priorRecords.values()].filter(
          (record) =>
            record.version === baseline.version &&
            record.target === expected.platform_label &&
            record.source_commit === prepared &&
            isRecord(record.artifact),
        );
        if (records.length !== 1)
          throw new Error("exact admitted predecessor package absent or ambiguous");
        const record = records[0]!;
        if (!Array.isArray(record.evidence_ids))
          throw new Error("prior native evidence reference absent");
        const refs = record.evidence_ids.filter(
          (entry: unknown) =>
            typeof entry === "string" && /^native-check:[1-9][0-9]*:[a-f0-9]{64}$/u.test(entry),
        );
        if (refs.length !== 1 || typeof refs[0] !== "string")
          throw new Error("prior native evidence reference ambiguous");
        const id = refs[0].split(":")[1],
          check = api.request("GET", `repos/boburning/portcove/check-runs/${id}`);
        if (check.status !== 200)
          throw new Error("authenticated historical native attribution unavailable");
        return {
          predecessor: inspectNativePublicationPredecessor(record, check.body),
          signed_context_sha256: signedContext,
          signatures_sha256: binding.signatures_sha256,
        };
      });
      if (digest(reader.releases()) !== digest(releases) || digest(reader.tags()) !== digest(tags))
        throw new Error("publication baseline changed during native attribution");
    }
    const expected = expectedBefore.map((item, index) =>
      inspectNativeQualificationExpectation({
        ...item,
        schema_version: 2,
        native_prepublication_profile: nativePrepublicationProfile,
        stage: "release-publication",
        journey: journeys[index],
      }),
    );
    await writeFile(path.join(directory, "expected.json"), JSON.stringify(expected), {
      flag: "wx",
      mode: 0o600,
    });
    phase = "actual-current-native-pair";
    const pair = await collectNativeReleaseQualificationPair(
      directory,
      expected,
      assembly,
      archives,
      "release-publication",
      deadline,
    );
    await requireActualTufPublication(actualTufPublication, deadline);
    await requireReceivedSigningContext(receivedContext, deadline);
    const after = await snapshot();
    if (after.checkpoint !== before.checkpoint)
      throw new Error("native publication reservation changed during collection");
    await associate(descriptor, after);
    remaining();
    return pair;
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("configured post-sign native collection refused; public evidence retained");
  }
}
