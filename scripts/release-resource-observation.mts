/** Advisory inventory only. Never resource admission, billing facts or ratification. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseDocument } from "yaml";
import { slice4CapacityResources, slice4CapacityResourceDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";

const catalogReaders = [
  "admission",
  "tool_bootstrap",
  "tool_attest",
  "coordinator",
  "catalog_definitions",
  "catalog_policy",
  "catalog_snapshot",
  "catalog_timestamp",
  "site_publication",
];
const catalogObservers = [
  "coordinator_protection_observation",
  "catalog_metadata_protection_observation",
  "site_protection_observation",
];
function document(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 512 * 1024, "bounded workflow source required");
  const parsed = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
  assert.equal(parsed.errors.length, 0);
  const value: unknown = parsed.toJS({ maxAliasCount: 100 });
  assert.ok(isRecord(value) && isRecord(value.jobs));
  return value.jobs;
}
function rows(workflow: string, bytes: Buffer) {
  return Object.entries(document(bytes)).map(([key, raw]) => {
    assert.ok(isRecord(raw));
    const timeout = raw["timeout-minutes"];
    assert.ok(
      timeout === undefined ||
        typeof timeout === "string" ||
        (Number.isSafeInteger(timeout) && Number(timeout) > 0 && Number(timeout) <= 360),
    );
    const alternatives =
      typeof timeout === "string"
        ? /^\$\{\{\s*(?:inputs\.report_only_repair|needs\.identity\.outputs\.release_profile\s*==\s*'initial-beta-win-linux')\s*&&\s*([1-9][0-9]*)\s*\|\|\s*([1-9][0-9]*)\s*\}\}$/u.exec(
            timeout,
          )
        : null;
    const purposeAlternatives =
      typeof timeout === "string"
        ? /^\$\{\{\s*inputs\.publication_purpose\s*==\s*'application'\s*&&\s*([1-9][0-9]*)\s*\|\|\s*([1-9][0-9]*)\s*\}\}$/u.exec(
            timeout,
          )
        : null;
    const values = alternatives
      ? [Number(alternatives[1]), Number(alternatives[2])]
      : purposeAlternatives
        ? [Number(purposeAlternatives[1]), Number(purposeAlternatives[2])]
        : null;
    if (values) assert.ok(values.every((value) => Number.isSafeInteger(value) && value <= 360));
    // GitHub's documented job default is360; reusable jobs retain their own declarations.
    const maximum =
      typeof timeout === "number"
        ? timeout
        : values
          ? Math.max(...values)
          : timeout === undefined && typeof raw.uses !== "string"
            ? 360
            : null;
    return {
      workflow,
      key,
      name: typeof raw.name === "string" ? raw.name : key,
      maximum_job_minutes: maximum,
      timeout_alternatives: values,
      purpose_maximum_job_minutes: purposeAlternatives
        ? { application: values![0]!, "catalog-publication": values![1]! }
        : null,
      timeout_origin:
        timeout === undefined
          ? typeof raw.uses === "string"
            ? "reusable-declaration"
            : "provider-default360"
          : typeof timeout === "number"
            ? "explicit"
            : purposeAlternatives
              ? "explicit-purpose-branches"
              : "expression-branch-not-selected",
      timeout_expression: typeof timeout === "string" ? timeout : null,
      reusable: typeof raw.uses === "string" ? raw.uses : null,
      runners: raw["runs-on"] ?? null,
      matrix: isRecord(raw.strategy) ? (raw.strategy.matrix ?? null) : null,
      condition: raw.if ?? null,
      observed_execution_seconds: null,
      observation_status: "Unknown",
      potential_billable_usage: "not inferred from declarations",
    };
  });
}
export function observeReleaseResources(production: Buffer, wake: Buffer, candidate: Buffer) {
  const policy = slice4CapacityResources,
    productionRows = rows("application-update-production.yml", production),
    wakeRows = rows("application-update-wake.yml", wake),
    candidateRows = rows("release.yml", candidate);
  const inputs = (key: string) =>
    key.includes("protection_observation") || key === "classification_writer";
  const forPurpose = (
    row: (typeof productionRows)[number],
    purpose: "application" | "catalog-publication",
  ) => ({
    ...row,
    maximum_job_minutes: row.purpose_maximum_job_minutes?.[purpose] ?? row.maximum_job_minutes,
  });
  const application = productionRows
    .filter((row) => !row.key.startsWith("catalog_"))
    .map((row) => forPurpose(row, "application"));
  const selected = (keys: string[]) =>
    keys.map((key) => {
      const row = productionRows.find((row) => row.key === key);
      assert.ok(row, `missing declared resource job ${key}`);
      return forPurpose(row, "catalog-publication");
    });
  const catalog = [...selected(catalogReaders), ...selected(catalogObservers)];
  const sum = (items: typeof productionRows) => {
    if (
      !items.every(
        (row) => row.maximum_job_minutes !== null && row.matrix === null && row.reusable === null,
      )
    )
      return null;
    return items.reduce((total, row) => total + Number(row.maximum_job_minutes), 0);
  };
  const unaccountedCatalog = productionRows
    .filter(
      (row) => row.key.startsWith("catalog_") && !catalog.some((known) => known.key === row.key),
    )
    .map((row) => row.key);
  const addWake = (value: number | null) =>
    value === null || wakeMinutes === null ? null : value + wakeMinutes;
  const wakeMinutes = sum(wakeRows),
    applicationMinutes = addWake(sum(application)),
    catalogMinutes = unaccountedCatalog.length ? null : addWake(sum(catalog));
  const digest = createHash("sha256").update(production).digest("hex"),
    matches = (actual: unknown, expected: unknown) =>
      JSON.stringify(actual) === JSON.stringify(expected);
  const policyMatches =
    digest === policy.aggregate_workflow_sha256 &&
    digest === policy.input_workflow_sha256 &&
    createHash("sha256").update(wake).digest("hex") === policy.wake_workflow_sha256 &&
    matches(
      application.filter((row) => !inputs(row.key)).map((row) => row.maximum_job_minutes),
      policy.aggregate_job_minutes,
    ) &&
    matches(
      application.filter((row) => inputs(row.key)).map((row) => row.maximum_job_minutes),
      policy.input_job_minutes,
    ) &&
    matches(
      selected(catalogReaders).map((row) => row.maximum_job_minutes),
      policy.catalog_job_minutes,
    ) &&
    matches(
      selected(catalogObservers).map((row) => row.maximum_job_minutes),
      policy.catalog_observer_job_minutes,
    ) &&
    applicationMinutes === policy.declared_job_minutes &&
    catalogMinutes === policy.catalog_declared_job_minutes;
  return {
    schema_version: 1,
    scope: "advisory declared allocation and observation gaps; not a resource policy",
    authority: "none",
    policy_digest: slice4CapacityResourceDigest,
    production_workflow_sha256: digest,
    policy_matches_workflow: policyMatches,
    ratification_required_for_policy_change: true,
    accounting: {
      unit: "aggregate declared runner-minute ceilings; not wall time or billable minutes",
      application: applicationMinutes,
      catalog_alternative: catalogMinutes,
      allocation_completeness: {
        application: applicationMinutes !== null,
        catalog: catalogMinutes !== null,
      },
      mutually_exclusive: true,
      policy_envelope: policy.total_job_minutes,
      declared_unused_allocation:
        applicationMinutes === null || catalogMinutes === null
          ? null
          : policy.total_job_minutes - Math.max(applicationMinutes, catalogMinutes),
      measured_wall_seconds: null,
      provider_availability: "Unknown",
      account_headroom: "Unknown",
      reservation: null,
      unaccounted_catalog_jobs: unaccountedCatalog,
    },
    jobs: productionRows.map((row) => ({
      ...row,
      purposes: [
        ...(application.some((item) => item.key === row.key) ? ["application"] : []),
        ...(catalog.some((item) => item.key === row.key) ? ["catalog"] : []),
      ],
    })),
    wake: wakeRows,
    separate_candidate_and_repair_workflow: candidateRows,
    report_repair: {
      minutes_per_attempt: policy.report_repair_job_minutes,
      maximum_attempts: policy.report_repair_attempts_per_candidate,
      maximum_minutes: policy.report_repair_maximum_job_minutes_per_candidate,
      included_in_controller_envelope: false,
    },
    spending: {
      account_stop:
        "preserve existing account-wide zero-spend control; not verified by this report",
      paid_fallback: false,
      larger_runners: "not_evaluated",
      settings_mutated: false,
    },
    recommendations: {
      per_job_minutes: null,
      aggregate_minutes: null,
      status:
        "measure equivalent hosted work and mandatory waits/cleanup before ratifying; missing evidence remains Unknown",
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    2,
    "advisory inventory takes no execution or admission options",
  );
  const [production, wake, candidate] = await Promise.all(
    ["application-update-production.yml", "application-update-wake.yml", "release.yml"].map(
      (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url)),
    ),
  );
  assert.ok(production && wake && candidate);
  console.log(JSON.stringify(observeReleaseResources(production, wake, candidate), null, 2));
}
