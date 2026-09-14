import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyApplicationVersion,
  proposeApplicationVersion,
} from "../apps/desktop/scripts/release-version-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const dayMilliseconds = 24 * 60 * 60 * 1000;
const publicationFreshnessMilliseconds = 15 * 60 * 1000;
const phases = new Set(["prepared", "qualifying", "building", "publishing", "promoting"]);
const failureKinds = new Set(["transient", "substantive", "authority"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, required, optional, label) {
  object(value, label);
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} is missing ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size) throw new Error(`${label} has unknown field ${[...keys].sort()[0]}`);
}

function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error(`${label} must be an exact lowercase commit identity`);
  return value;
}

function text(value, label, maximum = 128) {
  const containsControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    containsControlCharacter
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function boundedCount(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`${label} is outside its bounded budget`);
  return value;
}

function instant(value, label, optional = false) {
  if (optional && value === null) return null;
  const milliseconds = Date.parse(value ?? "");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new Error(`${label} must be a canonical UTC instant`);
  return milliseconds;
}

function uniqueStrings(value, label, validate = text) {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} must be an array`);
  value.forEach((entry) => validate(entry, `${label} entry`));
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  if (JSON.stringify(value) !== JSON.stringify([...value].sort()))
    throw new Error(`${label} must be sorted`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

function plan(action, reason, authority, details = {}) {
  const unsigned = {
    schema_version: 1,
    action,
    reason,
    authority,
    ...details,
  };
  return {
    ...unsigned,
    plan_sha256: createHash("sha256")
      .update(JSON.stringify(stable(unsigned)))
      .digest("hex"),
  };
}

function validateController(controller) {
  exactKeys(
    controller,
    ["workflow", "revision", "publication_paused", "free_capacity_available"],
    [],
    "controller",
  );
  text(controller.workflow, "controller workflow", 256);
  sha(controller.revision, "controller revision");
  boolean(controller.publication_paused, "publication pause");
  boolean(controller.free_capacity_available, "free capacity availability");
  return controller;
}

function validateOpportunity(opportunity) {
  exactKeys(
    opportunity,
    [
      "source_commit",
      "source_tree",
      "base_commit",
      "change_set_sha256",
      "complete_change_set",
      "meaningful",
      "documentation_only",
      "urgency",
      "requested_channel",
      "classification",
    ],
    [],
    "release opportunity",
  );
  sha(opportunity.source_commit, "opportunity source commit");
  sha(opportunity.source_tree, "opportunity source tree");
  sha(opportunity.base_commit, "opportunity base commit");
  if (!/^[a-f0-9]{64}$/u.test(opportunity.change_set_sha256 ?? ""))
    throw new Error("opportunity change-set digest is invalid");
  boolean(opportunity.complete_change_set, "complete change set");
  boolean(opportunity.meaningful, "meaningful change");
  boolean(opportunity.documentation_only, "documentation-only change");
  boolean(opportunity.urgency, "urgency");
  if (!opportunity.complete_change_set)
    throw new Error("release opportunity requires a complete accumulated change set");
  if (!["preview", "stable"].includes(opportunity.requested_channel))
    throw new Error("requested channel must be preview or stable");
  object(opportunity.classification, "reviewed classification");
  if (
    opportunity.classification.source_commit !== opportunity.source_commit ||
    opportunity.classification.reviewed_commit !== opportunity.source_commit ||
    opportunity.classification.source_tree !== opportunity.source_tree ||
    opportunity.classification.reviewed_tree !== opportunity.source_tree ||
    opportunity.classification.change_set_sha256 !== opportunity.change_set_sha256
  )
    throw new Error("reviewed classification is stale for the candidate identity");
  return opportunity;
}

function validatePublication(publication, now) {
  exactKeys(
    publication,
    [
      "complete",
      "observed_at",
      "published_versions",
      "published_sources",
      "reserved_versions",
      "last_routine_preview_at",
    ],
    [],
    "publication inventory",
  );
  if (publication.complete !== true) throw new Error("publication inventory is incomplete");
  const observed = instant(publication.observed_at, "publication observation");
  if (observed > now) throw new Error("publication observation is in the future");
  if (now - observed > publicationFreshnessMilliseconds)
    throw new Error("publication inventory is stale");
  uniqueStrings(publication.published_versions, "published versions");
  uniqueStrings(publication.published_sources, "published sources", sha);
  uniqueStrings(publication.reserved_versions, "reserved versions");
  const lastPreview = instant(publication.last_routine_preview_at, "last routine Preview", true);
  if (lastPreview !== null && lastPreview > now)
    throw new Error("last routine Preview is in the future");
  return { ...publication, observed, lastPreview };
}

function validateActive(active) {
  if (active === null) return null;
  exactKeys(
    active,
    [
      "source_commit",
      "source_tree",
      "prepared_commit",
      "prepared_tree",
      "version",
      "intent_sha256",
      "phase",
      "failure_kind",
      "transient_retries",
      "substantive_repairs",
    ],
    ["release_run"],
    "active candidate",
  );
  for (const field of ["source_commit", "source_tree", "prepared_commit", "prepared_tree"])
    sha(active[field], `active candidate ${field}`);
  if (!/^[a-f0-9]{64}$/u.test(active.intent_sha256 ?? ""))
    throw new Error("active candidate intent digest is invalid");
  text(active.version, "active candidate version");
  classifyApplicationVersion(active.version);
  if (!phases.has(active.phase) && active.phase !== "failed")
    throw new Error("active candidate phase is invalid or terminal");
  if (active.phase === "failed") {
    if (!failureKinds.has(active.failure_kind))
      throw new Error("failed active candidate requires a failure kind");
  } else if (active.failure_kind !== null) {
    throw new Error("nonfailed active candidate cannot carry a failure kind");
  }
  boundedCount(active.transient_retries, 2, "transient retries");
  boundedCount(active.substantive_repairs, 3, "substantive repairs");
  if (active.release_run !== undefined && active.release_run !== null) {
    exactKeys(active.release_run, ["run_id", "attempt", "revision"], [], "release run");
    if (!Number.isSafeInteger(active.release_run.run_id) || active.release_run.run_id < 1)
      throw new Error("release run ID is invalid");
    if (!Number.isSafeInteger(active.release_run.attempt) || active.release_run.attempt < 1)
      throw new Error("release run attempt is invalid");
    if (active.release_run.revision !== active.prepared_commit)
      throw new Error("release run is not bound to the prepared commit");
  }
  return active;
}

function activePlan(active, opportunity, authority) {
  const queued =
    opportunity.source_commit === active.source_commit
      ? null
      : {
          source_commit: opportunity.source_commit,
          source_tree: opportunity.source_tree,
          disposition: "coalesced-for-next-opportunity",
        };
  const exactCandidate = {
    source_commit: active.source_commit,
    source_tree: active.source_tree,
    prepared_commit: active.prepared_commit,
    prepared_tree: active.prepared_tree,
    version: active.version,
    intent_sha256: active.intent_sha256,
    phase: active.phase,
    failure_kind: active.failure_kind,
    transient_retries: active.transient_retries,
    substantive_repairs: active.substantive_repairs,
    release_run: active.release_run ?? null,
  };
  if (active.phase !== "failed")
    return plan(
      "resume-active",
      "finish the frozen active candidate without cancellation",
      authority,
      {
        active_candidate: exactCandidate,
        queued_candidate: queued,
      },
    );
  if (active.failure_kind === "transient" && active.transient_retries < 2)
    return plan(
      "retry-active",
      "retry bounded transient infrastructure on the same candidate",
      authority,
      {
        active_candidate: exactCandidate,
        retry_number: active.transient_retries + 1,
        retry_limit: 2,
        queued_candidate: queued,
      },
    );
  if (active.failure_kind === "substantive" && active.substantive_repairs < 3)
    return plan(
      "dispatch-repair",
      "diagnose and repair the held candidate before distribution",
      authority,
      {
        active_candidate: exactCandidate,
        repair_number: active.substantive_repairs + 1,
        repair_limit: 3,
        queued_candidate: queued,
      },
    );
  return plan(
    "pause-exception",
    active.failure_kind === "authority"
      ? "candidate needs missing production authority"
      : "candidate exhausted its bounded recovery budget",
    authority,
    { active_candidate: exactCandidate, queued_candidate: queued },
  );
}

/**
 * Decide one release opportunity without mutating Git, GitHub, artifacts, or feeds.
 * A trusted controller persists this output beside workflow/issue evidence and then
 * invokes the existing preparation and release workflows with the exact identities.
 */
export function planReleaseOpportunity(input) {
  exactKeys(
    input,
    ["schema_version", "now", "controller", "opportunity", "publication", "active_candidate"],
    [],
    "release coordinator input",
  );
  if (input.schema_version !== 1) throw new Error("unsupported release coordinator schema");
  const now = instant(input.now, "coordinator time");
  const controller = validateController(input.controller);
  const opportunity = validateOpportunity(input.opportunity);
  const publication = validatePublication(input.publication, now);
  const active = validateActive(input.active_candidate);
  const authority = {
    controller_workflow: controller.workflow,
    controller_revision: controller.revision,
    publication_observed_at: publication.observed_at,
    publication_sha256: createHash("sha256")
      .update(JSON.stringify(stable(input.publication)))
      .digest("hex"),
    opportunity_base_commit: opportunity.base_commit,
    opportunity_commit: opportunity.source_commit,
    opportunity_tree: opportunity.source_tree,
    change_set_sha256: opportunity.change_set_sha256,
    reviewed_classification_sha256: createHash("sha256")
      .update(JSON.stringify(stable(opportunity.classification)))
      .digest("hex"),
  };

  if (controller.publication_paused)
    return plan("pause", "publication emergency pause is active", authority);
  if (!controller.free_capacity_available)
    return plan("pause", "free runner or artifact capacity is unavailable", authority);
  if (active) {
    if (
      publication.reserved_versions.length !== 1 ||
      publication.reserved_versions[0] !== active.version
    )
      throw new Error("active candidate does not match the complete reservation inventory");
    return activePlan(active, opportunity, authority);
  }
  if (publication.reserved_versions.length)
    throw new Error("reserved versions require active-candidate recovery before allocation");
  if (!opportunity.meaningful || opportunity.documentation_only)
    return plan("skip", "no meaningful distributable application change", authority);
  if (publication.published_sources.includes(opportunity.source_commit))
    return plan("skip", "candidate commit is already in the publication inventory", authority);

  const routinePreview = opportunity.requested_channel === "preview" && !opportunity.urgency;
  if (
    routinePreview &&
    publication.lastPreview !== null &&
    now - publication.lastPreview < dayMilliseconds
  ) {
    return plan("coalesce", "routine Preview cadence has not elapsed", authority, {
      next_opportunity_at: new Date(publication.lastPreview + dayMilliseconds).toISOString(),
      queued_candidate: {
        source_commit: opportunity.source_commit,
        source_tree: opportunity.source_tree,
      },
    });
  }

  const proposal = proposeApplicationVersion(
    opportunity.classification,
    publication.published_versions,
  );
  classifyApplicationVersion(proposal.version, opportunity.requested_channel === "stable");
  return plan("prepare", "allocate and freeze one exact release candidate", authority, {
    requested_channel: opportunity.requested_channel,
    urgency_bypassed_cadence: opportunity.urgency,
    proposal,
    invocation: {
      preparation: "apps/desktop/scripts/prepare-release-version.mjs",
      qualification: ".github/workflows/qualification.yml",
      release: ".github/workflows/release.yml",
    },
  });
}

async function readInput(filename) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 1024 * 1024)
    throw new Error("release coordinator input must be a bounded regular file");
  return JSON.parse(await readFile(filename, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv.length !== 3) throw new Error("usage: release-coordinator.mjs INPUT.json");
  const input = await readInput(path.resolve(process.argv[2]));
  if (
    process.env.PORTCOVE_CONTROLLER_REVISION &&
    input.controller?.revision !== process.env.PORTCOVE_CONTROLLER_REVISION
  )
    throw new Error("coordinator input does not match the executing controller revision");
  if (
    process.env.PORTCOVE_CONTROLLER_WORKFLOW &&
    input.controller?.workflow !== process.env.PORTCOVE_CONTROLLER_WORKFLOW
  )
    throw new Error("coordinator input does not match the executing controller workflow");
  console.log(JSON.stringify(planReleaseOpportunity(input), null, 2));
}
