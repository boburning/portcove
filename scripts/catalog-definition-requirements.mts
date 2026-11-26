import { isRecord } from "./runtime-values.mts";

type DefinitionFiles = ReadonlyMap<string, Buffer>;
type CapabilityRange = { minimum: number; maximum: number };
type ReaderRequirements = {
  definitionSchema: number;
  projectionSchema: number;
  policySchema: number;
  policyDecisionSchema: number;
  launchSchema: number;
  features: ReadonlySet<string>;
  capabilities: ReadonlyMap<string, CapabilityRange>;
};

function target(files: DefinitionFiles, name: unknown) {
  const bytes = typeof name === "string" ? files.get(name) : undefined;
  if (!bytes) throw new Error("Reader requirement target is absent: " + String(name));
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(value)) throw new Error("Reader requirement target is malformed: " + String(name));
  return value;
}

function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid catalog reader requirement version");
  return value;
}

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid catalog reader requirement inventory");
  return value;
}

function readerRequirements(files: DefinitionFiles) {
  const subjects = new Map<string, ReaderRequirements>();
  for (const row of rows(target(files, "definitions/index.json").definitions)) {
    if (
      !isRecord(row) ||
      row.namespace !== "official" ||
      typeof row.stable_id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(row.stable_id) ||
      subjects.has(row.stable_id)
    )
      throw new Error("Invalid or duplicate official catalog reader subject");
    const id = row.stable_id;
    const entry = target(files, row.target);
    const projection = target(files, entry.execution_contract);
    const policy = target(files, `policy/official/${id}.json`);
    const launch = `policy/official/${id}.launch.json`;
    const capabilities = new Map<string, CapabilityRange>();
    for (const capability of rows(entry.required_capabilities)) {
      if (
        !isRecord(capability) ||
        typeof capability.template !== "string" ||
        capabilities.has(capability.template)
      )
        throw new Error("Invalid or duplicate catalog reader capability");
      const minimum = version(capability.minimum_version);
      const maximum = version(capability.maximum_version);
      if (maximum < minimum) throw new Error("Invalid catalog reader capability range");
      capabilities.set(capability.template, { minimum, maximum });
    }
    const features = new Set<string>();
    for (const feature of rows(
      entry.required_features === undefined ? [] : entry.required_features,
    )) {
      if (typeof feature !== "string" || features.has(feature))
        throw new Error("Invalid or duplicate named catalog reader feature");
      features.add(feature);
    }
    // Schema 1 is canonical only when the decision schema is absent.
    const decisionSchema =
      policy.decision_schema === undefined ? 1 : version(policy.decision_schema);
    if (policy.decision_schema !== undefined && decisionSchema === 1)
      throw new Error("Invalid explicit catalog policy decision schema");
    subjects.set(id, {
      definitionSchema: version(entry.definition_schema),
      projectionSchema: version(projection.contract_schema),
      policySchema: version(policy.policy_schema),
      policyDecisionSchema: decisionSchema,
      launchSchema: files.has(launch) ? version(target(files, launch).assessment_schema) : 0,
      features,
      capabilities,
    });
  }
  return subjects;
}

function exceeds(next: ReaderRequirements, prior: ReaderRequirements) {
  return (
    next.definitionSchema > prior.definitionSchema ||
    next.projectionSchema > prior.projectionSchema ||
    next.policySchema > prior.policySchema ||
    next.policyDecisionSchema > prior.policyDecisionSchema ||
    next.launchSchema > prior.launchSchema ||
    [...next.features].some((feature) => !prior.features.has(feature)) ||
    [...next.capabilities].some(([name, range]) => {
      const previousRange = prior.capabilities.get(name);
      return (
        !previousRange ||
        range.minimum > previousRange.minimum ||
        range.maximum < previousRange.maximum
      );
    })
  );
}

/** Compare operational requirements from previously verified publication inputs.
 * Listing carriers and artwork have their own publication checks. */
export function strengthenedReaderSubjects(prior: DefinitionFiles | null, next: DefinitionFiles) {
  const before = prior ? readerRequirements(prior) : null;
  const baseline = before ? [...before.values()] : [];
  return [...readerRequirements(next)]
    .filter(([id, requirement]) => {
      const previous = before?.get(id);
      if (previous) return exceeds(requirement, previous);
      if (
        requirement.definitionSchema >= 4 ||
        requirement.projectionSchema >= 4 ||
        requirement.policyDecisionSchema > 1 ||
        requirement.features.size
      )
        return true;
      // Initial legacy publication is allowed. A new legacy subject on an
      // established catalog needs to fit one previously supported requirement set.
      return before !== null && !baseline.some((previous) => !exceeds(requirement, previous));
    })
    .map(([id]) => id)
    .sort();
}
