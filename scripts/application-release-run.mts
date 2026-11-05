/** Native Release run custody. This records bounded execution identities in the
 * product draft/notes; it grants no qualification, signing or publication. */
import assert from "node:assert/strict";
import {
  metadataInstant,
  inspectMetadataRoleVersions,
  inspectTufPublicationFacts,
} from "./release-metadata-contract.mts";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { createReleasePublicationReader } from "./release-publication-inventory.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import type { inspectApplicationReleaseExecution } from "./application-release-policy.mts";
import {
  parseVersionClassification,
  classifyApplicationVersion,
} from "../apps/desktop/scripts/release-version-policy.mts";

const marker = "<!-- portcove-application-runs-v1\n";
const close = "\n-->";
const prefix = "repos/boburning/portcove";
type Execution = ReturnType<typeof inspectApplicationReleaseExecution>;
type Run = { id: string; control_commit: string; control_ref: string };
export function inspectApplicationQualificationIdentity(raw: unknown, source: string) {
  assert.ok(isRecord(raw));
  assert.ok(
    raw.workflow === ".github/workflows/qualification.yml" ||
      raw.workflow === ".github/workflows/application-release.yml",
  );
  assert.equal(raw.workflow_commit, source);
  const { run_id, attempt } = raw;
  assert.ok(typeof run_id === "number" && Number.isSafeInteger(run_id) && run_id > 0);
  assert.ok(typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0);
  return { workflow: raw.workflow, workflow_commit: source, run_id, attempt };
}
type Preparation = {
  source_commit: string;
  source_tree: string;
  prepared_commit: string;
  prepared_tree: string;
  version: string;
  intent_sha256: string;
  classification: ReturnType<typeof parseVersionClassification>;
  published_versions: string[];
  qualification?: ReturnType<typeof inspectApplicationQualificationIdentity>;
};
type BudgetScope = { opportunity: string; run_ids: string[] };
export type ApplicationRunBudget =
  | { kind: "owner"; scopes: BudgetScope[] }
  | { kind: "member"; owner_release_id: number; owner_opportunity: string };
export type ApplicationBudgetContext = { release_id?: number; custody: ApplicationRunCustody };
export type ApplicationReleaseReference = { release_id: number; opportunity: string };
export function inspectApplicationReleaseReference(raw: unknown): ApplicationReleaseReference {
  assert.ok(isRecord(raw) && Object.keys(raw).sort().join(",") === "opportunity,release_id");
  assert.ok(
    typeof raw.release_id === "number" &&
      Number.isSafeInteger(raw.release_id) &&
      raw.release_id > 0,
  );
  assert.ok(
    typeof raw.opportunity === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(raw.opportunity),
  );
  return { release_id: raw.release_id, opportunity: raw.opportunity };
}
export type ApplicationMetadataContextReservation = {
  opportunity: string;
  run_id: string;
  run_attempt: number;
  control_commit: string;
  control_ref: string;
  generated_at: string;
  root_sha256: string;
  offline_targets_sha256: string;
  prior_repository_sha256: string;
  versions: ReturnType<typeof inspectMetadataRoleVersions>;
  context_sha256: string;
  context_inventory_sha256: string;
  records_sha256: string;
};
export type ApplicationDraftAssembly = {
  authority_repository_sha256?: string;
  release_id: number;
  context_sha256: string;
  producer_attempt: number;
  prior_generation: string;
  prior_repository_sha256: string;
  retained_inventory_sha256: string;
  renewal_parent?: ApplicationReleaseReference;
  publication: ReturnType<typeof inspectTufPublicationFacts>;
  subjects: { name: string; bytes: number; sha256: string }[];
};

function inspectDraftAssemblies(
  raw: unknown,
  contexts: ApplicationMetadataContextReservation[],
): ApplicationDraftAssembly[] {
  assert.ok(Array.isArray(raw) && raw.length > 0 && raw.length <= contexts.length);
  let previous = -1;
  return raw.map((entry: unknown) => {
    assert.ok(isRecord(entry));
    assert.equal(
      Object.keys(entry).sort().join(","),
      (Object.hasOwn(entry, "renewal_parent") ? "authority_repository_sha256," : "") +
        "context_sha256,prior_generation,prior_repository_sha256,producer_attempt,publication,release_id," +
        (Object.hasOwn(entry, "renewal_parent") ? "renewal_parent," : "") +
        "retained_inventory_sha256,subjects",
    );
    const {
      release_id,
      context_sha256,
      producer_attempt,
      prior_generation,
      prior_repository_sha256,
      retained_inventory_sha256,
    } = entry;
    assert.ok(typeof release_id === "number" && Number.isSafeInteger(release_id) && release_id > 0);
    assert.ok(typeof producer_attempt === "number" && Number.isSafeInteger(producer_attempt));
    const index = contexts.findIndex((context) => context.context_sha256 === context_sha256);
    assert.ok(index > previous, "draft assembly history is unordered or has no reservation");
    previous = index;
    const context = contexts[index];
    assert.ok(context);
    assert.ok(producer_attempt >= context.run_attempt && producer_attempt <= 3);
    assert.ok(typeof context_sha256 === "string");
    assert.ok(typeof prior_generation === "string" && /^[a-f0-9]{64}$/u.test(prior_generation));
    assert.ok(
      typeof prior_repository_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(prior_repository_sha256),
    );
    assert.ok(
      typeof retained_inventory_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(retained_inventory_sha256),
    );
    const publication = inspectTufPublicationFacts(entry.publication);
    assert.equal(publication.root_sha256, context.root_sha256);
    assert.equal(publication.offline_targets_sha256, context.offline_targets_sha256);
    assert.equal(publication.records_sha256, context.records_sha256);
    assert.deepEqual(publication.versions, context.versions);
    const renewalParent = Object.hasOwn(entry, "renewal_parent")
      ? inspectApplicationReleaseReference(entry.renewal_parent)
      : undefined;
    const authorityRepository = renewalParent ? entry.authority_repository_sha256 : undefined;
    if (renewalParent) {
      assert.equal(authorityRepository, context.prior_repository_sha256);
      assert.notEqual(authorityRepository, prior_repository_sha256);
      assert.notEqual(renewalParent.opportunity, context.opportunity);
    } else assert.equal(prior_repository_sha256, context.prior_repository_sha256);
    const rawSubjects = entry.subjects;
    assert.ok(Array.isArray(rawSubjects) && rawSubjects.length === 2);
    const subjects = ["application-site.zip", "application-metadata.json"].map((name, index) => {
      const subject: unknown = rawSubjects[index];
      assert.ok(isRecord(subject) && Object.keys(subject).sort().join(",") === "bytes,name,sha256");
      assert.equal(subject.name, name);
      assert.ok(
        typeof subject.bytes === "number" &&
          Number.isSafeInteger(subject.bytes) &&
          subject.bytes > 0 &&
          subject.bytes <= (index === 0 ? 512 : 2) * 1024 ** 2,
      );
      assert.ok(typeof subject.sha256 === "string" && /^[a-f0-9]{64}$/u.test(subject.sha256));
      return { name, bytes: subject.bytes, sha256: subject.sha256 };
    });
    return {
      release_id,
      context_sha256,
      producer_attempt,
      prior_generation,
      prior_repository_sha256,
      retained_inventory_sha256,
      publication,
      subjects,
      ...(renewalParent
        ? {
            renewal_parent: renewalParent,
            authority_repository_sha256: context.prior_repository_sha256,
          }
        : {}),
    };
  });
}

export type ApplicationDraftRecoveryPreimage = {
  release_id: number;
  old_context_sha256: string;
  replacement_context_sha256: string;
  retained_assets_sha256: string;
  assets: { id: number; name: string }[];
};

export type ApplicationDraftRecovery = ApplicationDraftRecoveryPreimage & {
  backup: { id: number; bytes: number; sha256: string; run_attempt: number };
};

function inspectDraftRecoveries(
  raw: unknown,
  assemblies: ApplicationDraftAssembly[],
  contexts: ApplicationMetadataContextReservation[],
): ApplicationDraftRecovery[] {
  assert.ok(Array.isArray(raw) && raw.length > 0 && raw.length < assemblies.length);
  let previous = -1;
  const usedArtifacts = new Set<number>();
  return raw.map((entry: unknown) => {
    assert.ok(isRecord(entry));
    assert.equal(
      Object.keys(entry).sort().join(","),
      "assets,backup,old_context_sha256,release_id,replacement_context_sha256,retained_assets_sha256",
    );
    const old = assemblies.find((assembly) => assembly.context_sha256 === entry.old_context_sha256);
    const index = assemblies.findIndex(
      (assembly) => assembly.context_sha256 === entry.replacement_context_sha256,
    );
    const replacement = assemblies[index];
    assert.ok(old && replacement && index > previous && assemblies.indexOf(old) < index);
    previous = index;
    assert.equal(entry.release_id, old.release_id);
    assert.equal(entry.release_id, replacement.release_id);
    const oldContext = contexts.find((context) => context.context_sha256 === old.context_sha256);
    const replacementContext = contexts.find(
      (context) => context.context_sha256 === replacement.context_sha256,
    );
    assert.ok(oldContext && replacementContext);
    assert.equal(oldContext.opportunity, replacementContext.opportunity);
    const retained = entry.retained_assets_sha256;
    assert.ok(typeof retained === "string" && /^[a-f0-9]{64}$/u.test(retained));
    assert.ok(Array.isArray(entry.assets) && entry.assets.length > 0 && entry.assets.length <= 2);
    const ids = new Set<number>();
    const names = new Set<string>();
    const assets = entry.assets.map((asset: unknown) => {
      assert.ok(isRecord(asset) && Object.keys(asset).sort().join(",") === "id,name");
      const { id, name } = asset;
      assert.ok(typeof id === "number" && Number.isSafeInteger(id) && id > 0 && !ids.has(id));
      assert.ok(typeof name === "string" && !names.has(name));
      assert.ok(old.subjects.some((subject) => subject.name === name));
      ids.add(id);
      names.add(name);
      return { id, name };
    });
    const backup = entry.backup;
    assert.ok(
      isRecord(backup) && Object.keys(backup).sort().join(",") === "bytes,id,run_attempt,sha256",
    );
    const { id, bytes, sha256, run_attempt } = backup;
    assert.ok(
      typeof id === "number" && Number.isSafeInteger(id) && id > 0 && !usedArtifacts.has(id),
    );
    assert.ok(
      typeof bytes === "number" &&
        Number.isSafeInteger(bytes) &&
        bytes >= 22 &&
        bytes <= 512 * 1024 ** 2,
    );
    assert.ok(typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256));
    assert.ok(
      typeof run_attempt === "number" &&
        Number.isSafeInteger(run_attempt) &&
        run_attempt >= replacement.producer_attempt &&
        run_attempt <= 3,
    );
    usedArtifacts.add(id);
    return {
      release_id: replacement.release_id,
      old_context_sha256: old.context_sha256,
      replacement_context_sha256: replacement.context_sha256,
      retained_assets_sha256: retained,
      assets,
      backup: { id, bytes, sha256, run_attempt },
    };
  });
}

type ApplicationDraftRemovalClaim = {
  asset_id: number;
  replacement_context_sha256: string;
};

function inspectDraftRemovalClaims(raw: unknown, recoveries: ApplicationDraftRecovery[]) {
  assert.ok(Array.isArray(raw) && raw.length > 0 && raw.length <= recoveries.length * 2);
  const used = new Set<number>();
  return raw.map((value: unknown): ApplicationDraftRemovalClaim => {
    assert.ok(isRecord(value));
    assert.equal(Object.keys(value).sort().join(","), "asset_id,replacement_context_sha256");
    const recovery = recoveries.find(
      (entry) => entry.replacement_context_sha256 === value.replacement_context_sha256,
    );
    assert.ok(recovery);
    const asset = recovery.assets.find((entry) => entry.id === value.asset_id);
    assert.ok(asset && !used.has(asset.id), "old asset ID already claimed for removal");
    used.add(asset.id);
    return { asset_id: asset.id, replacement_context_sha256: recovery.replacement_context_sha256 };
  });
}

export type ApplicationRunCustody = {
  schema_version: 1 | 2 | 3;
  draft_assemblies?: ApplicationDraftAssembly[];
  draft_recoveries?: ApplicationDraftRecovery[];
  draft_removal_claims?: ApplicationDraftRemovalClaim[];
  metadata_contexts?: ApplicationMetadataContextReservation[];
  budget?: ApplicationRunBudget;
  kind: "application-release-run-custody";
  source: string;
  source_tree: string;
  opportunity: string;
  preparation: Preparation | null;
  runs: Run[];
};

export function inspectApplicationRunCustody(raw: unknown): ApplicationRunCustody {
  assert.ok(isRecord(raw));
  assert.equal(
    Object.keys(raw).sort().join(","),
    [
      "kind",
      "opportunity",
      "preparation",
      "runs",
      "schema_version",
      "source",
      "source_tree",
      ...(raw.schema_version === 2 || (raw.schema_version === 3 && Object.hasOwn(raw, "budget"))
        ? ["budget"]
        : []),
      ...(raw.schema_version === 3 ? ["metadata_contexts"] : []),
      ...(raw.schema_version === 3 && Object.hasOwn(raw, "draft_assemblies")
        ? ["draft_assemblies"]
        : []),
      ...(raw.schema_version === 3 && Object.hasOwn(raw, "draft_recoveries")
        ? ["draft_recoveries"]
        : []),
      ...(raw.schema_version === 3 && Object.hasOwn(raw, "draft_removal_claims")
        ? ["draft_removal_claims"]
        : []),
    ]
      .sort()
      .join(","),
  );
  assert.ok(raw.schema_version === 1 || raw.schema_version === 2 || raw.schema_version === 3);
  assert.equal(raw.kind, "application-release-run-custody");
  assert.ok(typeof raw.source === "string" && /^[a-f0-9]{40}$/u.test(raw.source));
  assert.ok(typeof raw.source_tree === "string" && /^[a-f0-9]{40}$/u.test(raw.source_tree));
  assert.ok(
    typeof raw.opportunity === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(raw.opportunity),
  );
  let preparation: Preparation | null = null;
  if (raw.preparation !== null) {
    const value = raw.preparation;
    assert.ok(isRecord(value));
    assert.equal(
      Object.keys(value).sort().join(","),
      "classification,intent_sha256,prepared_commit,prepared_tree,published_versions," +
        (Object.hasOwn(value, "qualification") ? "qualification," : "") +
        "source_commit,source_tree,version",
    );
    for (const key of ["source_commit", "source_tree", "prepared_commit", "prepared_tree"] as const)
      assert.ok(typeof value[key] === "string" && /^[a-f0-9]{40}$/u.test(value[key]));
    assert.equal(value.source_commit, raw.source);
    assert.equal(value.source_tree, raw.source_tree);
    assert.equal(
      raw.opportunity,
      raw.source,
      "application preparation requires a source opportunity",
    );
    assert.ok(typeof value.version === "string");
    classifyApplicationVersion(value.version);
    assert.ok(
      typeof value.intent_sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.intent_sha256),
    );
    const classification = parseVersionClassification(value.classification);
    assert.equal(classification.source_commit, raw.source);
    assert.ok(Array.isArray(value.published_versions) && value.published_versions.length <= 1600);
    const published_versions = value.published_versions.map((version: unknown) => {
      assert.ok(typeof version === "string");
      classifyApplicationVersion(version);
      return version;
    });
    assert.equal(new Set(published_versions).size, published_versions.length);
    const qualification = Object.hasOwn(value, "qualification")
      ? inspectApplicationQualificationIdentity(value.qualification, raw.source)
      : undefined;
    if (qualification) assert.deepEqual(value.qualification, qualification);
    preparation = {
      source_commit: raw.source,
      source_tree: raw.source_tree,
      prepared_commit: String(value.prepared_commit),
      prepared_tree: String(value.prepared_tree),
      version: value.version,
      intent_sha256: value.intent_sha256,
      classification,
      published_versions,
      ...(qualification ? { qualification } : {}),
    };
  }
  assert.ok(Array.isArray(raw.runs) && raw.runs.length >= 1 && raw.runs.length <= 3);
  const seen = new Set<string>();
  const runs = raw.runs.map((value: unknown): Run => {
    assert.ok(isRecord(value));
    assert.equal(Object.keys(value).sort().join(","), "control_commit,control_ref,id");
    assert.ok(typeof value.id === "string" && /^[1-9][0-9]{0,15}$/u.test(value.id));
    assert.ok(Number.isSafeInteger(Number(value.id)) && !seen.has(value.id));
    seen.add(value.id);
    assert.ok(
      typeof value.control_commit === "string" && /^[a-f0-9]{40}$/u.test(value.control_commit),
    );
    assert.ok(
      typeof value.control_ref === "string" &&
        /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u.test(
          value.control_ref,
        ),
    );
    return { id: value.id, control_commit: value.control_commit, control_ref: value.control_ref };
  });
  let budget: ApplicationRunBudget | undefined;
  if (Object.hasOwn(raw, "budget")) {
    const value = raw.budget;
    assert.ok(isRecord(value));
    if (value.kind === "owner") {
      assert.equal(Object.keys(value).sort().join(","), "kind,scopes");
      assert.ok(
        Array.isArray(value.scopes) && value.scopes.length >= 1 && value.scopes.length <= 2,
      );
      const opportunities = new Set<string>(),
        ids = new Set(runs.map((run) => run.id));
      const scopes = value.scopes.map((scope: unknown): BudgetScope => {
        assert.ok(isRecord(scope));
        assert.equal(Object.keys(scope).sort().join(","), "opportunity,run_ids");
        assert.ok(
          typeof scope.opportunity === "string" &&
            /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(scope.opportunity) &&
            !opportunities.has(scope.opportunity),
        );
        assert.notEqual(scope.opportunity, raw.opportunity);
        opportunities.add(scope.opportunity);
        assert.ok(
          Array.isArray(scope.run_ids) && scope.run_ids.length >= 1 && scope.run_ids.length <= 3,
        );
        const run_ids = scope.run_ids.map((id: unknown) => {
          assert.ok(
            typeof id === "string" &&
              /^[1-9][0-9]{0,15}$/u.test(id) &&
              Number.isSafeInteger(Number(id)) &&
              !ids.has(id),
          );
          ids.add(id);
          return id;
        });
        return { opportunity: scope.opportunity, run_ids };
      });
      assert.ok(ids.size <= 3, "one application opportunity retains at most three registered runs");
      budget = { kind: "owner", scopes };
    } else {
      assert.equal(value.kind, "member");
      assert.equal(Object.keys(value).sort().join(","), "kind,owner_opportunity,owner_release_id");
      assert.ok(
        typeof value.owner_release_id === "number" &&
          Number.isSafeInteger(value.owner_release_id) &&
          value.owner_release_id > 0,
      );
      assert.ok(
        typeof value.owner_opportunity === "string" &&
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.owner_opportunity),
      );
      assert.notEqual(value.owner_opportunity, raw.opportunity);
      budget = {
        kind: "member",
        owner_release_id: value.owner_release_id,
        owner_opportunity: value.owner_opportunity,
      };
    }
  }
  const metadata =
    raw.schema_version === 3
      ? inspectMetadataContextReservations(raw.metadata_contexts, {
          opportunity: raw.opportunity,
          runs,
          ...(budget ? { budget } : {}),
        })
      : undefined;
  const assemblies =
    metadata && Object.hasOwn(raw, "draft_assemblies")
      ? inspectDraftAssemblies(raw.draft_assemblies, metadata)
      : undefined;
  const recoveries = Object.hasOwn(raw, "draft_recoveries")
    ? inspectDraftRecoveries(raw.draft_recoveries, assemblies ?? [], metadata ?? [])
    : undefined;
  return {
    schema_version: raw.schema_version,
    ...(metadata ? { metadata_contexts: metadata } : {}),
    ...(assemblies ? { draft_assemblies: assemblies } : {}),
    ...(recoveries ? { draft_recoveries: recoveries } : {}),
    ...(Object.hasOwn(raw, "draft_removal_claims")
      ? {
          draft_removal_claims: inspectDraftRemovalClaims(
            raw.draft_removal_claims,
            recoveries ?? [],
          ),
        }
      : {}),
    ...(budget ? { budget } : {}),
    kind: "application-release-run-custody",
    source: raw.source,
    source_tree: raw.source_tree,
    opportunity: raw.opportunity,
    preparation,
    runs,
  };
}

export function readApplicationRunNotes(body: unknown) {
  assert.ok(typeof body === "string" && Buffer.byteLength(body) <= 65536);
  const at = body.indexOf(marker);
  if (at < 0) return null;
  assert.equal(body.lastIndexOf(marker), at, "duplicate native run custody markers");
  const end = body.indexOf(close, at + marker.length);
  assert.ok(end >= 0, "incomplete native run custody marker");
  return {
    custody: inspectApplicationRunCustody(JSON.parse(body.slice(at + marker.length, end))),
    before: body.slice(0, at),
    after: body.slice(end + close.length),
  };
}

function notes(value: ApplicationRunCustody, before: string, after: string) {
  const result = `${before}${marker}${JSON.stringify(inspectApplicationRunCustody(value))}${close}${after}`;
  assert.ok(Buffer.byteLength(result) <= 65536);
  return result;
}

/** The fixed caller owns actual global Actions concurrency and current guards.
 * After an ambiguous mutation, read back the exact existing release; never
 * retry a POST, delete a draft, replace assets or reset a registered run list. */
export async function registerApplicationReleaseRun(
  api: CoordinatorRemoteApi,
  execution: Execution,
  source: string,
  tree: string,
  opportunity: string,
  beforeWrite: (
    knownRunIds: readonly string[],
    context?: ApplicationBudgetContext,
  ) => Promise<void>,
  mode: "create-or-resume" | "immutable-only" | "immutable-metadata-only" = "create-or-resume",
  budget?: ApplicationRunBudget,
) {
  const current: Run = {
    id: execution.run_id,
    control_commit: execution.source,
    control_ref: execution.ref,
  };
  const initial = inspectApplicationRunCustody({
    schema_version: budget ? 2 : 1,
    ...(budget ? { budget } : {}),
    kind: "application-release-run-custody",
    source,
    source_tree: tree,
    opportunity,
    preparation: null,
    runs: [current],
  });
  const candidateTag = `portcove-production-candidate-${opportunity}`;
  const started = performance.now();
  let calls = 0;
  const request = (method: string, suffix: string, body?: unknown) => {
    assert.ok(++calls <= 6 && performance.now() - started < 120000);
    const response = api.request(method, `${prefix}/${suffix}`, body);
    assert.ok(performance.now() - started < 120000);
    return response;
  };
  const find = () => {
    const matches = createReleasePublicationReader(api)
      .releaseNotes()
      .filter((release) => {
        const parsed = readApplicationRunNotes(release.body ?? "");
        // Keep the original source SHA as this native metadata anchor even when
        // publishing an already-created version tag at the prepared child. Git
        // tag identity is separately verified; target_commitish is not proof of
        // the tag's commit. Missing notes must never erase registered costs.
        if (parsed)
          assert.equal(
            release.target_commitish,
            parsed.custody.source,
            "native release source anchor changed",
          );
        if (!parsed && release.target_commitish === source)
          throw new Error("existing source release lost its native run custody; hold");
        if (release.tag_name === candidateTag)
          assert.ok(
            parsed && parsed.custody.opportunity === opportunity,
            "candidate draft lost its run custody; hold",
          );
        return parsed?.custody.opportunity === opportunity;
      });
    assert.ok(matches.length <= 1, "duplicate native release source reservation");
    return matches[0];
  };
  const existing = find();
  const parsed = existing ? readApplicationRunNotes(existing.body ?? "") : null;
  assert.ok(
    mode === "create-or-resume" || mode === "immutable-only" || mode === "immutable-metadata-only",
  );
  if (mode === "immutable-only") {
    assert.ok(
      existing && parsed?.custody.preparation,
      "immutable recovery requires an existing prepared cohort; no new draft",
    );
    assert.equal(existing.draft, false);
    assert.equal(existing.immutable, true);
    assert.equal(existing.prerelease, true);
    assert.equal(existing.tag_name, `v${parsed.custody.preparation.version}`);
  }
  if (mode === "immutable-metadata-only") {
    assert.match(opportunity, /^[a-f0-9]{64}$/u);
    assert.ok(
      existing && parsed && parsed.custody.preparation === null,
      "immutable metadata recovery requires its existing metadata cohort; no new draft",
    );
    assert.equal(existing.draft, false);
    assert.equal(existing.immutable, true);
    assert.equal(existing.prerelease, true);
    assert.equal(existing.tag_name, candidateTag);
  }
  if (existing) assert.ok(parsed);
  if (parsed) {
    if (budget)
      assert.deepEqual(parsed.custody.budget, budget, "native budget membership cannot change");
    assert.equal(parsed.custody.source, source);
    assert.equal(parsed.custody.source_tree, tree);
  }
  const previous = parsed?.custody ?? initial;
  const already = parsed?.custody.runs.find((run) => run.id === current.id);
  if (already) assert.deepEqual(already, current, "existing run has another fixed control source");
  const nextRuns = parsed && !already ? [...previous.runs, current] : previous.runs;
  const next = inspectApplicationRunCustody({ ...previous, runs: nextRuns });
  const body = notes(
    next,
    parsed?.before ??
      "Portcove application preparation. No publication or acceptance is implied.\n\n",
    parsed?.after ?? "",
  );
  await beforeWrite(parsed?.custody.runs.map((run) => run.id) ?? [], {
    ...(existing ? { release_id: Number(existing.id) } : {}),
    custody: next,
  });
  let release: unknown = existing;
  if (!existing || !already) {
    // Recheck the full preimage after the caller's fresh protection/cost reads.
    if (existing) {
      const fresh = request("GET", `releases/${Number(existing.id)}`);
      assert.equal(fresh.status, 200);
      assert.ok(isRecord(fresh.body));
      for (const key of [
        "id",
        "body",
        "name",
        "tag_name",
        "target_commitish",
        "draft",
        "immutable",
        "prerelease",
      ])
        assert.deepEqual(
          fresh.body[key],
          existing[key],
          `release ${key} changed before native run registration`,
        );
    } else assert.equal(find(), undefined, "release appeared before native draft creation");
    try {
      const response = existing
        ? request("PATCH", `releases/${Number(existing.id)}`, { body })
        : request("POST", "releases", {
            tag_name: candidateTag,
            target_commitish: source,
            name: `Portcove application preparation ${source.slice(0, 12)}`,
            body,
            draft: true,
            prerelease: true,
            make_latest: "false",
          });
      assert.equal(response.status, existing ? 200 : 201);
      release = response.body;
    } catch {
      release = existing ?? find();
    }
  }
  assert.ok(
    isRecord(release) && Number.isSafeInteger(release.id) && Number(release.id) > 0,
    "native draft mutation outcome unknown; hold without another POST",
  );
  const readback = request("GET", `releases/${Number(release.id)}`);
  assert.equal(readback.status, 200);
  assert.ok(isRecord(readback.body));
  assert.equal(readback.body.body, body, "native run custody readback differs; no retry or reset");
  if (existing) {
    for (const key of ["id", "tag_name", "target_commitish", "draft", "immutable", "prerelease"])
      assert.equal(readback.body[key], existing[key], `registration changed release ${key}`);
  } else {
    assert.equal(readback.body.tag_name, candidateTag);
    assert.equal(readback.body.target_commitish, source);
    assert.equal(readback.body.draft, true);
    assert.equal(readback.body.immutable, false);
    assert.equal(readback.body.prerelease, true);
  }
  return {
    release_id: Number(release.id),
    custody: next,
    known_run_ids: next.runs.map((run) => run.id),
    authority: "none" as const,
  };
}

export function readRegisteredApplicationRuns(
  api: CoordinatorRemoteApi,
  releaseId: number,
  opportunity: string,
  source: string,
  tree: string,
  execution: Execution,
) {
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
  const response = api.request("GET", `${prefix}/releases/${releaseId}`);
  assert.equal(response.status, 200);
  assert.ok(isRecord(response.body) && response.body.id === releaseId);
  assert.equal(response.body.target_commitish, source, "native release source anchor changed");
  const parsed = readApplicationRunNotes(response.body.body);
  assert.ok(parsed, "registered release lost native run custody");
  assert.equal(parsed.custody.opportunity, opportunity);
  assert.equal(parsed.custody.source, source);
  assert.equal(parsed.custody.source_tree, tree);
  const selected = parsed.custody.runs.find((run) => run.id === execution.run_id);
  assert.deepEqual(selected, {
    id: execution.run_id,
    control_commit: execution.source,
    control_ref: execution.ref,
  });
  return parsed.custody;
}

export async function retainApplicationPreparation(
  api: CoordinatorRemoteApi,
  releaseId: number,
  expected: ApplicationRunCustody,
  preparation: Preparation,
  beforeWrite: (
    knownRunIds: readonly string[],
    context?: ApplicationBudgetContext,
  ) => Promise<void>,
) {
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
  const next = inspectApplicationRunCustody({ ...expected, preparation });
  if (expected.preparation)
    assert.deepEqual(
      expected.preparation,
      next.preparation,
      "source preparation cannot be reallocated",
    );
  await beforeWrite(
    expected.runs.map((run) => run.id),
    { release_id: releaseId, custody: expected },
  );
  const before = api.request("GET", `${prefix}/releases/${releaseId}`);
  assert.equal(before.status, 200);
  assert.ok(isRecord(before.body) && before.body.id === releaseId);
  const parsed = readApplicationRunNotes(before.body.body);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.custody,
    expected,
    "source reservation changed before preparation custody",
  );
  if (!expected.preparation) {
    assert.equal(
      before.body.draft,
      true,
      "application preparation must precede immutable publication",
    );
    assert.equal(before.body.immutable, false);
    const body = notes(next, parsed.before, parsed.after);
    try {
      api.request("PATCH", `${prefix}/releases/${releaseId}`, { body });
    } catch {
      /* Readback decides; no repeated mutation. */
    }
    const after = api.request("GET", `${prefix}/releases/${releaseId}`);
    assert.equal(after.status, 200);
    assert.ok(isRecord(after.body) && after.body.id === releaseId);
    assert.equal(after.body.body, body, "preparation custody outcome unknown; no retry or reset");
    for (const key of ["tag_name", "target_commitish", "draft", "immutable", "prerelease"])
      assert.equal(after.body[key], before.body[key], `preparation changed release ${key}`);
  }
  return next;
}

/** Resolve the one native cost owner. Membership is a reference, never a copy
 * of another cost ledger, and owner chains/cycles are not accepted. */
export function readApplicationBudgetOwner(
  api: Pick<CoordinatorRemoteApi, "request">,
  context: ApplicationBudgetContext,
): ApplicationBudgetContext {
  const custody = inspectApplicationRunCustody(context.custody);
  if (custody.budget?.kind !== "member") return { ...context, custody };
  const link = custody.budget;
  assert.notEqual(context.release_id, link.owner_release_id);
  const response = api.request("GET", `${prefix}/releases/${link.owner_release_id}`);
  assert.equal(response.status, 200);
  assert.ok(isRecord(response.body) && response.body.id === link.owner_release_id);
  const parsed = readApplicationRunNotes(response.body.body);
  assert.ok(parsed?.custody.budget?.kind === "owner", "native cost owner is missing or chained");
  assert.equal(response.body.target_commitish, parsed.custody.source);
  assert.equal(parsed.custody.opportunity, link.owner_opportunity);
  const scope = parsed.custody.budget.scopes.find(
    (scope) => scope.opportunity === custody.opportunity,
  );
  assert.ok(scope, "renewal membership was not registered with its original cost owner");
  // Owner accounting precedes the member write. An interrupted append may
  // therefore leave additional cost IDs here; retain and charge every one.
  // Actual private admission separately requires the current member actor.
  assert.ok(
    custody.runs.every((run) => scope.run_ids.includes(run.id)),
    "native cost owner lost a registered member execution",
  );
  return { release_id: link.owner_release_id, custody: parsed.custody };
}

/** Register a forward-maintenance run with its original owner BEFORE creating
 * the member draft or accessing keys. The callback checks source/pause/spending
 * authorization only: admission may refuse AFTER this actual run is recorded.
 * This accounting write grants no private work. Older code rejects schema2 rather than
 * silently dropping related costs. A failed/lost PATCH is read back once. */
export async function registerApplicationBudgetRun(
  api: Pick<CoordinatorRemoteApi, "request">,
  context: ApplicationBudgetContext,
  opportunity: string,
  execution: Execution,
  beforeRecord: () => Promise<void>,
) {
  assert.match(opportunity, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  const owner = readApplicationBudgetOwner(api, context);
  assert.ok(
    typeof owner.release_id === "number" &&
      Number.isSafeInteger(owner.release_id) &&
      owner.release_id > 0,
  );
  assert.notEqual(opportunity, owner.custody.opportunity);
  const budget = owner.custody.budget;
  assert.ok(budget === undefined || budget.kind === "owner");
  const scopes = budget?.kind === "owner" ? budget.scopes : [];
  const current = scopes.find((scope) => scope.opportunity === opportunity);
  const nextScopes = current
    ? scopes.map((scope) =>
        scope === current
          ? { ...scope, run_ids: [...new Set([...scope.run_ids, execution.run_id])] }
          : scope,
      )
    : [...scopes, { opportunity, run_ids: [execution.run_id] }];
  const next = inspectApplicationRunCustody({
    ...owner.custody,
    schema_version: owner.custody.metadata_contexts ? 3 : 2,
    budget: { kind: "owner", scopes: nextScopes },
  });
  const endpoint = `${prefix}/releases/${owner.release_id}`;
  const get = () => {
    const response = api.request("GET", endpoint);
    assert.equal(response.status, 200);
    assert.ok(isRecord(response.body) && response.body.id === owner.release_id);
    assert.equal(response.body.target_commitish, owner.custody.source);
    return response.body;
  };
  const before = get();
  const parsed = readApplicationRunNotes(before.body);
  assert.ok(parsed);
  assert.deepEqual(parsed.custody, owner.custody, "native cost owner changed before linking");
  const body = notes(next, parsed.before, parsed.after);
  await beforeRecord();
  if (body !== before.body) {
    assert.deepEqual(get(), before, "native cost owner preimage changed");
    try {
      const result = api.request("PATCH", endpoint, { body });
      assert.equal(result.status, 200);
    } catch {
      /* Readback alone resolves an ambiguous note update. */
    }
  }
  const after = get();
  assert.equal(after.body, body, "native cost registration unknown; no retry/reset");
  assert.deepEqual(
    applicationReleaseNotesPreimage(after),
    applicationReleaseNotesPreimage(before),
    "cost registration changed another release field",
  );
  return {
    owner: { release_id: owner.release_id, custody: next },
    membership: {
      kind: "member" as const,
      owner_release_id: owner.release_id,
      owner_opportunity: owner.custody.opportunity,
    },
    authority: "none" as const,
  };
}

/** Native notes retain burnt versions; they supply no signing authority. */
function inspectMetadataContextReservations(
  raw: unknown,
  owner: Pick<ApplicationRunCustody, "opportunity" | "runs" | "budget">,
): ApplicationMetadataContextReservation[] {
  assert.ok(
    owner.budget?.kind !== "member",
    "metadata reservations belong only to the original cost owner",
  );
  assert.ok(Array.isArray(raw) && raw.length >= 1 && raw.length <= 3);
  const seen = new Set<string>();
  let previous: ApplicationMetadataContextReservation | undefined;
  return raw.map((value: unknown) => {
    assert.ok(isRecord(value));
    assert.equal(
      Object.keys(value).sort().join(","),
      "context_inventory_sha256,context_sha256,control_commit,control_ref,generated_at,offline_targets_sha256,opportunity,prior_repository_sha256,records_sha256,root_sha256,run_attempt,run_id,versions",
    );
    assert.ok(
      typeof value.opportunity === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.opportunity),
    );
    assert.ok(
      typeof value.run_id === "string" &&
        /^[1-9][0-9]{0,15}$/u.test(value.run_id) &&
        Number.isSafeInteger(Number(value.run_id)),
    );
    assert.ok(
      typeof value.run_attempt === "number" &&
        Number.isSafeInteger(value.run_attempt) &&
        value.run_attempt >= 1 &&
        value.run_attempt <= 3,
    );
    const actor = `${value.run_id}/${value.run_attempt}`;
    assert.ok(
      !seen.has(actor),
      "a native context producer cannot reserve different metadata twice",
    );
    seen.add(actor);
    assert.ok(
      typeof value.control_commit === "string" && /^[a-f0-9]{40}$/u.test(value.control_commit),
    );
    assert.ok(
      typeof value.control_ref === "string" &&
        /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u.test(
          value.control_ref,
        ),
    );
    if (value.opportunity === owner.opportunity) {
      const run = owner.runs.find((run) => run.id === value.run_id);
      assert.ok(
        run && run.control_commit === value.control_commit && run.control_ref === value.control_ref,
      );
    } else {
      assert.ok(
        owner.budget?.kind === "owner" &&
          owner.budget.scopes.some(
            (scope) =>
              scope.opportunity === value.opportunity &&
              scope.run_ids.includes(String(value.run_id)),
          ),
        "metadata context lost its original registered cost scope",
      );
    }
    assert.ok(typeof value.generated_at === "string");
    metadataInstant(value.generated_at);
    for (const key of [
      "root_sha256",
      "offline_targets_sha256",
      "prior_repository_sha256",
      "context_sha256",
      "context_inventory_sha256",
      "records_sha256",
    ] as const)
      assert.ok(typeof value[key] === "string" && /^[a-f0-9]{64}$/u.test(value[key]));
    const versions = inspectMetadataRoleVersions(value.versions);
    const current = {
      opportunity: value.opportunity,
      run_id: value.run_id,
      run_attempt: value.run_attempt,
      control_commit: value.control_commit,
      control_ref: value.control_ref,
      generated_at: value.generated_at,
      root_sha256: String(value.root_sha256),
      offline_targets_sha256: String(value.offline_targets_sha256),
      prior_repository_sha256: String(value.prior_repository_sha256),
      versions,
      context_sha256: String(value.context_sha256),
      context_inventory_sha256: String(value.context_inventory_sha256),
      records_sha256: String(value.records_sha256),
    };
    if (previous) {
      assert.equal(current.root_sha256, previous.root_sha256);
      assert.equal(current.offline_targets_sha256, previous.offline_targets_sha256);
      assert.ok(
        metadataInstant(current.generated_at) >= metadataInstant(previous.generated_at),
        "metadata reservation clock regressed",
      );
      for (const role of Object.keys(versions) as (keyof typeof versions)[])
        if (role === "targets") assert.equal(versions[role], previous.versions[role]);
        else
          assert.ok(
            BigInt(versions[role]) > BigInt(previous.versions[role]),
            "metadata reservation reused an online version",
          );
    }
    previous = current;
    return current;
  });
}

/** Only append-only metadata facts may extend an already admitted source packet.
 * All source, preparation, run and financial fields remain exact. */
export function assertApplicationCustodyMetadataExtension(
  expectedRaw: unknown,
  currentRaw: unknown,
) {
  const expected = inspectApplicationRunCustody(expectedRaw),
    current = inspectApplicationRunCustody(currentRaw);
  const economic = (custody: ApplicationRunCustody) => {
    const {
      metadata_contexts: _metadata,
      draft_assemblies: _assemblies,
      draft_recoveries: _recoveries,
      draft_removal_claims: _claims,
      ...base
    } = custody;
    return { ...base, schema_version: custody.budget ? 2 : 1 };
  };
  assert.deepEqual(
    economic(current),
    economic(expected),
    "native source or financial reservation changed",
  );
  const before = expected.metadata_contexts ?? [],
    after = current.metadata_contexts ?? [];
  assert.ok(after.length >= before.length);
  assert.deepEqual(after.slice(0, before.length), before, "metadata reservation history changed");
  const beforeAssemblies = expected.draft_assemblies ?? [];
  const afterAssemblies = current.draft_assemblies ?? [];
  assert.ok(afterAssemblies.length >= beforeAssemblies.length);
  assert.deepEqual(
    afterAssemblies.slice(0, beforeAssemblies.length),
    beforeAssemblies,
    "draft assembly history changed",
  );
  const beforeRecoveries = expected.draft_recoveries ?? [];
  const afterRecoveries = current.draft_recoveries ?? [];
  assert.deepEqual(
    afterRecoveries.slice(0, beforeRecoveries.length),
    beforeRecoveries,
    "draft recovery history changed",
  );
  const beforeClaims = expected.draft_removal_claims ?? [];
  const afterClaims = current.draft_removal_claims ?? [];
  assert.deepEqual(
    afterClaims.slice(0, beforeClaims.length),
    beforeClaims,
    "draft removal claim history changed",
  );
  return current;
}

/** Read the original native owner before preparing bytes. Callers cannot appoint
 * a clock or version floor; only preserved producer reservations select reuse. */
export function readApplicationMetadataContextPlan(
  api: Pick<CoordinatorRemoteApi, "request">,
  context: ApplicationBudgetContext,
  execution: Execution,
) {
  const original = readApplicationBudgetOwner(api, context);
  assert.ok(typeof original.release_id === "number" && original.release_id > 0);
  const response = api.request("GET", `${prefix}/releases/${original.release_id}`);
  assert.equal(response.status, 200);
  assert.ok(
    isRecord(response.body) &&
      response.body.id === original.release_id &&
      response.body.target_commitish === original.custody.source,
  );
  const parsed = readApplicationRunNotes(response.body.body);
  assert.ok(parsed);
  const custody = assertApplicationCustodyMetadataExtension(original.custody, parsed.custody);
  const reservations = custody.metadata_contexts ?? [];
  const existing = reservations.find(
    (entry) => entry.run_id === execution.run_id && entry.run_attempt === execution.run_attempt,
  );
  if (existing) {
    assert.equal(existing.opportunity, context.custody.opportunity);
    assert.equal(existing.control_commit, execution.source);
    assert.equal(existing.control_ref, execution.ref);
    assert.equal(reservations.at(-1), existing, "a later reservation superseded this producer");
  }
  const previous = existing ? reservations.at(-2) : reservations.at(-1);
  const generated_at =
    existing?.generated_at ??
    new Date()
      .toISOString()
      .replace(/\.([0-9]*?)0+Z$/u, (_all: string, fraction: string) =>
        fraction ? `.${fraction}Z` : "Z",
      );
  if (previous)
    assert.ok(
      metadataInstant(generated_at) >= metadataInstant(previous.generated_at),
      "metadata clock regressed",
    );
  return {
    owner: { release_id: original.release_id, custody },
    existing,
    generated_at,
    ...(previous ? { previous_reserved_versions: previous.versions } : {}),
    authority: "none" as const,
  };
}

/** One guarded notes append BEFORE context upload/key access. Ambiguity is read
 * back once; neither a POST, version reuse, nor another writer is retried. */
export async function retainApplicationMetadataContext(
  api: Pick<CoordinatorRemoteApi, "request">,
  context: ApplicationBudgetContext,
  execution: Execution,
  reservation: ApplicationMetadataContextReservation,
  beforeWrite: () => Promise<void>,
) {
  const plan = readApplicationMetadataContextPlan(api, context, execution);
  assert.equal(reservation.opportunity, context.custody.opportunity);
  assert.equal(reservation.run_id, execution.run_id);
  assert.equal(reservation.run_attempt, execution.run_attempt);
  assert.equal(reservation.control_commit, execution.source);
  assert.equal(reservation.control_ref, execution.ref);
  if (plan.existing)
    assert.deepEqual(reservation, plan.existing, "native context reuse changed exact bytes");
  const next = inspectApplicationRunCustody({
    ...plan.owner.custody,
    schema_version: 3,
    metadata_contexts: plan.existing
      ? plan.owner.custody.metadata_contexts
      : [...(plan.owner.custody.metadata_contexts ?? []), reservation],
  });
  return writeApplicationMetadataNotes(api, plan.owner, next, beforeWrite);
}

/** Retain the exact attested pair before either asset can be staged. */
export async function retainApplicationDraftAssembly(
  api: Pick<CoordinatorRemoteApi, "request">,
  context: ApplicationBudgetContext,
  execution: Execution,
  assembly: ApplicationDraftAssembly,
  beforeWrite: () => Promise<void>,
) {
  const { owner } = readApplicationMetadataContextPlan(api, context, execution);
  const reservation = owner.custody.metadata_contexts?.at(-1);
  assert.ok(reservation);
  assert.equal(reservation.context_sha256, assembly.context_sha256);
  assert.equal(reservation.opportunity, context.custody.opportunity);
  assert.equal(reservation.run_id, execution.run_id);
  assert.equal(reservation.control_commit, execution.source);
  assert.equal(reservation.control_ref, execution.ref);
  assert.equal(context.release_id, assembly.release_id);
  assert.ok(assembly.producer_attempt <= execution.run_attempt);
  const history = owner.custody.draft_assemblies ?? [];
  const existing = history.find((entry) => entry.context_sha256 === assembly.context_sha256);
  if (existing)
    assert.deepEqual(assembly, existing, "draft assembly changed under its reservation");
  const next = inspectApplicationRunCustody({
    ...owner.custody,
    draft_assemblies: existing ? history : [...history, assembly],
  });
  return writeApplicationMetadataNotes(api, owner, next, beforeWrite);
}

/** Reuse the original cost owner and the guarded, read-back notes writer.
 * The fixed caller verifies the provider artifact bytes and current draft before writing. */
export async function retainApplicationDraftRecovery(
  api: Pick<CoordinatorRemoteApi, "request">,
  context: ApplicationBudgetContext,
  execution: Execution,
  recovery: ApplicationDraftRecovery,
  beforeWrite: () => Promise<void>,
) {
  const { owner } = readApplicationMetadataContextPlan(api, context, execution);
  const reservation = owner.custody.metadata_contexts?.at(-1);
  assert.ok(reservation);
  assert.equal(reservation.context_sha256, recovery.replacement_context_sha256);
  assert.equal(reservation.opportunity, context.custody.opportunity);
  assert.equal(reservation.run_id, execution.run_id);
  assert.equal(reservation.control_commit, execution.source);
  assert.equal(reservation.control_ref, execution.ref);
  assert.equal(context.release_id, recovery.release_id);
  assert.equal(recovery.backup.run_attempt, execution.run_attempt);
  const history = owner.custody.draft_recoveries ?? [];
  const existing = history.find(
    (entry) => entry.replacement_context_sha256 === recovery.replacement_context_sha256,
  );
  if (existing) assert.deepEqual(recovery, existing, "draft recovery backup or preimage changed");
  const next = inspectApplicationRunCustody({
    ...owner.custody,
    draft_recoveries: existing ? history : [...history, recovery],
  });
  return writeApplicationMetadataNotes(api, owner, next, beforeWrite);
}

/** The fixed workflow serializes release actors. A read-back claim is spent
 * even if the worker is interrupted before requesting DELETE. */
export async function claimApplicationDraftAssetRemoval(
  api: Pick<CoordinatorRemoteApi, "request">,
  context: ApplicationBudgetContext,
  execution: Execution,
  recovery: ApplicationDraftRecovery,
  assetId: number,
  beforeWrite: () => Promise<void>,
) {
  const { owner } = readApplicationMetadataContextPlan(api, context, execution);
  const reservation = owner.custody.metadata_contexts?.at(-1);
  assert.ok(reservation);
  assert.equal(reservation.context_sha256, recovery.replacement_context_sha256);
  assert.equal(reservation.opportunity, context.custody.opportunity);
  assert.equal(reservation.run_id, execution.run_id);
  assert.equal(reservation.control_commit, execution.source);
  assert.equal(reservation.control_ref, execution.ref);
  assert.equal(context.release_id, recovery.release_id);
  assert.ok(recovery.assets.some((asset) => asset.id === assetId));
  assert.deepEqual(
    owner.custody.draft_recoveries?.find(
      (entry) => entry.replacement_context_sha256 === recovery.replacement_context_sha256,
    ),
    recovery,
  );
  const claims = owner.custody.draft_removal_claims ?? [];
  if (claims.some((claim) => claim.asset_id === assetId)) return undefined;
  const next = inspectApplicationRunCustody({
    ...owner.custody,
    draft_removal_claims: [
      ...claims,
      {
        asset_id: assetId,
        replacement_context_sha256: recovery.replacement_context_sha256,
      },
    ],
  });
  const written = await writeApplicationMetadataNotes(api, owner, next, beforeWrite);
  return { release_id: written.release_id, notes: written.notes };
}

/** A notes PATCH may advance the provider's edit clock. Other fields remain exact. */
export function applicationReleaseNotesPreimage(release: Record<string, unknown>) {
  const { body: _body, updated_at: _updatedAt, ...preimage } = release;
  return preimage;
}

async function writeApplicationMetadataNotes(
  api: Pick<CoordinatorRemoteApi, "request">,
  owner: { release_id: number; custody: ApplicationRunCustody },
  next: ApplicationRunCustody,
  beforeWrite: () => Promise<void>,
) {
  const started = performance.now();
  const endpoint = `${prefix}/releases/${owner.release_id}`;
  const get = () => {
    const result = api.request("GET", endpoint);
    assert.equal(result.status, 200);
    assert.ok(performance.now() - started < 120000);
    assert.ok(isRecord(result.body) && result.body.id === owner.release_id);
    return result.body;
  };
  const before = get(),
    parsed = readApplicationRunNotes(before.body);
  assert.ok(parsed);
  assert.deepEqual(parsed.custody, owner.custody, "metadata owner preimage changed");
  const body = notes(next, parsed.before, parsed.after);
  await beforeWrite();
  assert.deepEqual(get(), before, "metadata owner changed during admission");
  if (body !== before.body) {
    try {
      const result = api.request("PATCH", endpoint, { body });
      assert.equal(result.status, 200);
    } catch {
      /* Exact readback resolves an ambiguous write; no repeated PATCH. */
    }
  }
  const after = get();
  assert.equal(after.body, body, "metadata reservation outcome unknown; retain versions and hold");
  assert.deepEqual(
    applicationReleaseNotesPreimage(after),
    applicationReleaseNotesPreimage(before),
    "metadata reservation changed another release field",
  );
  return { release_id: owner.release_id, custody: next, notes: body, authority: "none" as const };
}
