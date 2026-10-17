import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRecord } from "../runtime-values.mts";
import { isValidationDomain, isFingerprintRuntime } from "../validation-evidence.mts";
import type {
  FingerprintInventory,
  RepositoryInventory,
  ValidationRuntime,
  FingerprintRuntime,
} from "../validation-evidence.mts";
import type { AuditStage } from "../audit.mts";

function baselineCase(raw: unknown) {
  assert(isRecord(raw) && typeof raw.label === "string" && typeof raw.expected === "string");
  const stage = raw.stage;
  assert(
    isRecord(stage) &&
      typeof stage.id === "string" &&
      typeof stage.recipe === "string" &&
      isValidationDomain(stage.domain) &&
      typeof stage.reusable === "boolean",
  );
  assert(stage.reason === undefined || typeof stage.reason === "string");
  assert(
    stage.platforms === undefined ||
      (Array.isArray(stage.platforms) &&
        stage.platforms.every((value: unknown) => typeof value === "string")),
  );
  const checkedStage: AuditStage = {
    ...stage,
    id: stage.id,
    recipe: stage.recipe,
    domain: stage.domain,
    reusable: stage.reusable,
  };
  const inventory = raw.inventory;
  assert(
    isRecord(inventory) &&
      typeof inventory.head === "string" &&
      (inventory.objectFormat === undefined ||
        inventory.objectFormat === "sha1" ||
        inventory.objectFormat === "sha256") &&
      Array.isArray(inventory.files),
  );
  const files: FingerprintInventory["files"] = inventory.files.map((file: unknown) => {
    assert(
      isRecord(file) &&
        typeof file.path === "string" &&
        (file.kind === "file" ||
          file.kind === "missing" ||
          file.kind === "symlink" ||
          file.kind === "other") &&
        typeof file.ambiguous === "boolean" &&
        Array.isArray(file.domains),
    );
    const domains = file.domains.map((domain: unknown) => {
      assert(isValidationDomain(domain));
      return domain;
    });
    const identities: Partial<
      Pick<
        RepositoryInventory["files"][number],
        "sha256" | "headMode" | "indexMode" | "worktreeMode" | "headBlob" | "indexBlob" | "gitBlob"
      >
    > = {};
    for (const key of [
      "sha256",
      "headMode",
      "indexMode",
      "worktreeMode",
      "headBlob",
      "indexBlob",
      "gitBlob",
    ] as const) {
      const value = file[key];
      assert(value === undefined || value === null || typeof value === "string");
      if (value !== undefined) identities[key] = value;
    }
    return {
      ...file,
      ...identities,
      path: file.path,
      kind: file.kind,
      ambiguous: file.ambiguous,
      domains,
    };
  });
  const checkedInventory: FingerprintInventory & Pick<RepositoryInventory, "head"> = {
    ...inventory,
    head: inventory.head,
    ...(inventory.objectFormat === undefined ? {} : { objectFormat: inventory.objectFormat }),
    files,
  };
  const runtime = raw.runtime;
  assert(isFingerprintRuntime(runtime));
  return {
    ...raw,
    label: raw.label,
    expected: raw.expected,
    stage: checkedStage,
    inventory: checkedInventory,
    runtime,
  };
}
const raw: unknown = JSON.parse(
  readFileSync(new URL("./audit-fingerprint-baseline.json", import.meta.url), "utf8"),
);
assert(isRecord(raw) && Array.isArray(raw.cases));
export const baseline = { ...raw, cases: raw.cases.map(baselineCase) };

/** The first fixture already has every content digest. Fill unused inventory bookkeeping only. */
export function firstAuditBaseline() {
  const first = structuredClone(baseline.cases[0]);
  assert(first);
  const objectFormat = first.inventory.objectFormat;
  assert(objectFormat !== undefined);
  const runtime = first.runtime;
  for (const value of Object.values(runtime)) assert(value !== null);
  // The first case is a complete measured runtime; nullable optionals belong to later historical cases.
  function assertMeasuredRuntime(value: FingerprintRuntime): asserts value is ValidationRuntime {
    for (const key of [
      "rustc",
      "cargo",
      "cargoNextest",
      "cargoShear",
      "rscheck",
      "aqua",
      "powershell",
      "packageManager",
      "packageManagerVersion",
    ] as const)
      assert(value[key] !== null);
  }
  assertMeasuredRuntime(runtime);
  const files: RepositoryInventory["files"] = first.inventory.files.map((file) => {
    assert(file.sha256 === null || typeof file.sha256 === "string");
    return {
      ...file,
      sha256: file.sha256,
      headMode: file.headMode ?? null,
      indexMode: file.indexMode ?? null,
      worktreeMode: file.worktreeMode ?? null,
      headBlob: file.headBlob ?? null,
      indexBlob: file.indexBlob ?? null,
      gitBlob: file.gitBlob ?? null,
      untracked: false,
    };
  });
  return { ...first, runtime, inventory: { ...first.inventory, objectFormat, files } };
}
