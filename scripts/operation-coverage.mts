import {
  fileIdentity,
  readBoundedEvidenceFile,
  type FileIdentity,
} from "./development-evidence.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { catalogReport } from "./desktop-scenarios.mts";
import {
  compatibleAcceptanceScenarios,
  revalidateAcceptancePacket,
  inspectAcceptancePreflight,
} from "./acceptance-packet.mts";

const kinds = ["browser-fixture", "native-harness-contract", "real-installed-execution"] as const;
type ObservationKind = (typeof kinds)[number];
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;

export async function readCoverageInput(file: string) {
  const { identity, bytes } = await readBoundedEvidenceFile(file, 4 * 1024 * 1024);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  return { identity, value };
}

/** Read-only evidence projection: Core owns offers; the existing verifier owns receipts. */
export async function operationCoverage(
  qualification: unknown,
  receipts: readonly FileIdentity[] = [],
  currentPreflights: readonly unknown[] = [],
) {
  if (
    !isRecord(qualification) ||
    qualification.report_format !== 1 ||
    !isRecord(qualification.evidence) ||
    !digest(qualification.cli_sha256) ||
    !text(qualification.captured_at)
  )
    throw new Error("Expected an identified qualification capture");
  const evidence = qualification.evidence;
  const statusEnvelope = evidence.status;
  const doctorEnvelope = evidence.doctor;
  if (
    !isRecord(statusEnvelope) ||
    statusEnvelope.ok !== true ||
    !Array.isArray(statusEnvelope.data) ||
    !isRecord(doctorEnvelope) ||
    doctorEnvelope.ok !== true ||
    !isRecord(doctorEnvelope.data)
  )
    throw new Error("Coverage requires complete Core status and doctor snapshots");
  if (receipts.length > 128 || new Set(receipts.map((item) => item.path)).size !== receipts.length)
    throw new Error("Coverage requires at most128 distinct receipt paths");
  if (receipts.length && !currentPreflights.length)
    throw new Error("Receipt compatibility requires scoped current preflight packets");
  if (currentPreflights.length > 128) throw new Error("Too many requested preflight scopes");
  const requestedPreflights = [];
  const scopeKeys = new Set<string>();
  for (const current of currentPreflights) {
    const inspected = inspectAcceptancePreflight(current);
    const { bindings, source_review, known_gaps, prerequisites, source_review_complete } =
      inspected;
    const scope = bindings.execution_qualification.initial_state.offered_operation;
    const scoped =
      isRecord(scope) &&
      kinds.includes(scope.evidence_kind as ObservationKind) &&
      ["port_id", "operation", "runtime_kind", "platform", "producer"].every((key) =>
        text(scope[key]),
      );
    if (scoped) {
      const key = JSON.stringify(
        [
          "port_id",
          "operation",
          "runtime_kind",
          "record_id",
          "platform",
          "package_sha256",
          "package_platform",
          "evidence_kind",
        ].map((field) => scope[field] ?? null),
      );
      if (scopeKeys.has(key)) throw new Error("Duplicate requested operation scope");
      scopeKeys.add(key);
    }
    for (const input of [
      ...bindings.product_artifacts,
      ...bindings.harness_inputs,
      ...bindings.execution_qualification.fixture_identities,
    ]) {
      const actual = await fileIdentity(input.path, { maxBytes: input.bytes });
      if (actual.sha256 !== input.sha256 || actual.bytes !== input.bytes)
        throw new Error("Requested preflight input bytes changed");
    }
    const required_gaps = known_gaps.filter((gap) => gap.required === true);
    requestedPreflights.push({
      scope: scoped ? scope : null,
      source_review,
      required_gaps,
      descriptive_prerequisites: prerequisites,
      clear:
        Boolean(scoped) &&
        source_review_complete &&
        source_review.outcome === "passed" &&
        source_review.source_head === bindings.source_head &&
        !required_gaps.length,
    });
  }
  const inventoryGaps: string[] = [];
  const catalogEnvelope = evidence.catalog;
  const catalogIds = new Set<string>();
  if (
    !isRecord(catalogEnvelope) ||
    catalogEnvelope.ok !== true ||
    !isRecord(catalogEnvelope.data) ||
    !Array.isArray(catalogEnvelope.data.ports)
  )
    inventoryGaps.push("Complete catalog snapshot unavailable");
  else
    for (const port of catalogEnvelope.data.ports) {
      if (!isRecord(port) || !text(port.id) || catalogIds.has(String(port.id)))
        throw new Error("Invalid or duplicate catalog port identity");
      catalogIds.add(String(port.id));
    }
  const platform = text(doctorEnvelope.data.platform);
  const executionPlatform = platform?.startsWith("windows-")
    ? "win32"
    : platform?.startsWith("linux-")
      ? "linux"
      : platform?.startsWith("macos-")
        ? "darwin"
        : null;
  const scenarios = catalogReport();
  const ports = new Set<string>();
  const records = new Set<string>();
  const offers = statusEnvelope.data.flatMap((status: unknown) => {
    if (!isRecord(status) || !text(status.port_id) || !Array.isArray(status.port_actions))
      throw new Error("Core offered-operation inventory is missing");
    const portId = String(status.port_id);
    if (ports.has(portId)) throw new Error("Duplicate Core port identity");
    ports.add(portId);
    if (!status.port_actions.length)
      inventoryGaps.push(`Core operation assessments unavailable for ${portId}`);
    if (status.active != null && status.external_runtime != null)
      throw new Error("Ambiguous managed/external operation target");
    const runtimeKind =
      status.active != null
        ? "managed"
        : status.external_runtime != null
          ? "external"
          : "uninstalled";
    const runtime = status.active ?? status.external_runtime;
    if (runtime != null && (!isRecord(runtime) || !text(runtime.id)))
      throw new Error("Operation target has no runtime identity");
    const record = isRecord(runtime) ? runtime : {};
    if (runtime != null) {
      if (record.port_id != null && record.port_id !== portId)
        throw new Error("Runtime record owner differs from Core offer");
      const identity = `${runtimeKind}:${String(record.id)}`;
      if (records.has(identity)) throw new Error("Duplicate Core runtime identity");
      records.add(identity);
    }
    const packageSha =
      runtimeKind === "external"
        ? digest(record.archive_sha256)
        : isRecord(record.artifact)
          ? digest(record.artifact.sha256)
          : null;
    const actions = new Set<string>();
    return status.port_actions.flatMap((assessment: unknown) => {
      if (
        !isRecord(assessment) ||
        !text(assessment.action) ||
        !["not_offered", "waiting", "held", "allowed"].includes(String(assessment.availability)) ||
        !text(assessment.reason)
      )
        throw new Error("Invalid Core operation assessment");
      const operation = String(assessment.action);
      if (actions.has(operation)) throw new Error("Duplicate Core operation assessment");
      actions.add(operation);
      if (assessment.availability === "not_offered") return [];
      return [
        {
          port_id: portId,
          operation,
          availability: String(assessment.availability),
          reason: String(assessment.reason),
          runtime_kind: runtimeKind,
          record_id: text(record.id),
          platform,
          package: {
            artifact_sha256: packageSha,
            installed_platform: runtimeKind === "external" ? text(record.platform) : null,
          },
          intended_producers: scenarios
            .filter(
              (scenario) =>
                !scenario.platforms ||
                (executionPlatform && scenario.platforms.includes(executionPlatform)),
            )
            .filter((scenario) =>
              scenario.operation_routes?.some(
                (route) =>
                  route.operation === operation &&
                  (!route.runtime_kind || route.runtime_kind === runtimeKind),
              ),
            )
            .map(({ id, source, platforms, profiles }) => ({
              scenario: id,
              source,
              platforms: platforms ?? null,
              profiles,
            })),
        },
      ];
    });
  });
  for (const id of catalogIds)
    if (!ports.has(id)) inventoryGaps.push(`Catalog port missing from Core status: ${id}`);
  for (const id of ports)
    if (!catalogIds.has(id)) inventoryGaps.push(`Core status port missing from catalog: ${id}`);
  const errors: { receipt: FileIdentity; message: string }[] = [];
  const packets: {
    identity: FileIdentity;
    packet: Awaited<ReturnType<typeof revalidateAcceptancePacket>>;
    compatible: string[];
  }[] = [];
  for (const identity of receipts) {
    try {
      const packet = await revalidateAcceptancePacket(identity);
      const compatible = [
        ...new Set(
          currentPreflights.flatMap(
            (current) => compatibleAcceptanceScenarios(packet, current).compatible,
          ),
        ),
      ];
      packets.push({ identity, packet, compatible });
    } catch (error) {
      errors.push({ receipt: identity, message: errorMessage(error).slice(0, 4096) });
    }
  }
  const rows = offers.map((offer) => {
    const observations: Partial<
      Record<
        ObservationKind,
        {
          receipt: FileIdentity;
          completed_at: string;
          captured_at: string;
          outcome: string;
          qualification_complete: boolean;
        }
      >
    > = {};
    const unorderable: { kind: ObservationKind; receipt: FileIdentity }[] = [];
    for (const { identity, packet, compatible } of packets) {
      const scope = packet.bindings.execution_qualification.initial_state.offered_operation;
      const conditions = packet.bindings.execution_qualification.runtime_conditions;
      if (
        !isRecord(scope) ||
        conditions.observation_kind !== scope.evidence_kind ||
        conditions.platform !== scope.platform ||
        !kinds.includes(scope.evidence_kind as ObservationKind) ||
        scope.port_id !== offer.port_id ||
        scope.operation !== offer.operation ||
        scope.runtime_kind !== offer.runtime_kind ||
        scope.record_id !== offer.record_id ||
        scope.availability !== offer.availability ||
        scope.reason !== offer.reason ||
        !offer.platform ||
        scope.platform !== offer.platform ||
        !offer.package.artifact_sha256 ||
        scope.package_sha256 !== offer.package.artifact_sha256 ||
        (offer.package.installed_platform !== null &&
          scope.package_platform !== offer.package.installed_platform) ||
        !packet.bindings.product_artifacts.some(
          (product) => product.sha256 === qualification.cli_sha256,
        ) ||
        !compatible.includes(String(scope.producer)) ||
        !offer.intended_producers.some((producer) => producer.scenario === scope.producer)
      )
        continue;
      const kind = scope.evidence_kind as ObservationKind;
      const outcome = packet.outcomes.find((item) => item.scenario === scope.producer)?.outcome;
      if (!outcome) continue;
      if (!packet.observation_captured_at) {
        unorderable.push({ kind, receipt: identity });
        continue;
      }
      const previous = observations[kind];
      // A newer failed compatible receipt wins over an older green one.
      if (
        !previous ||
        Date.parse(packet.observation_captured_at) > Date.parse(previous.captured_at) ||
        (Date.parse(packet.observation_captured_at) === Date.parse(previous.captured_at) &&
          (outcome !== "passed" || !packet.qualification_complete))
      )
        observations[kind] = {
          receipt: identity,
          completed_at: packet.completed_at,
          captured_at: packet.observation_captured_at,
          outcome,
          qualification_complete: packet.qualification_complete,
        };
    }
    const ambiguous = unorderable.some((item) => item.kind === "real-installed-execution");
    const latest = ambiguous ? null : (observations["real-installed-execution"] ?? null);
    return {
      ...offer,
      observations_by_kind: observations,
      unorderable_compatible_receipts: unorderable,
      latest_compatible_receipt: latest,
      missing_observation: ambiguous
        ? "Compatible receipt has no verifier-bound observation time; latest is unknown"
        : latest
          ? null
          : "No compatible validated real-installed execution receipt was supplied",
      mandatory_observation: ambiguous
        ? "incomplete"
        : !latest
          ? "missing"
          : latest.outcome === "passed" && latest.qualification_complete
            ? "recorded"
            : "failed",
      missing_identity: !offer.platform || !executionPlatform || !offer.package.artifact_sha256,
      missing_producer: offer.intended_producers.length === 0,
    };
  });
  return {
    format_version: 1,
    captured_at: qualification.captured_at,
    cli_sha256: qualification.cli_sha256,
    interpretation:
      "Read-only Core offers and revalidated receipts with declared, hash-bound observation kinds. Evidence kinds remain separate. This report grants no acceptance and makes no global claim about receipts not supplied.",
    rows,
    supplied_receipts: packets.map(({ identity, packet, compatible }) => ({
      receipt: identity,
      declared_scope:
        packet.bindings.execution_qualification.initial_state.offered_operation ?? null,
      outcomes: packet.outcomes,
      qualification_complete: packet.qualification_complete,
      compatible_scenarios: compatible,
    })),
    receipt_validation_errors: errors,
    requested_preflights: requestedPreflights,
    inventory_gaps: inventoryGaps,
    inventory_complete: inventoryGaps.length === 0,
    coverage_state: rows.length
      ? "offered-operations"
      : inventoryGaps.length
        ? "incomplete"
        : "empty",
    observations_complete:
      !errors.length &&
      !inventoryGaps.length &&
      rows.length > 0 &&
      requestedPreflights.every((item) => item.clear) &&
      rows.every(
        (row) =>
          row.mandatory_observation === "recorded" &&
          !row.missing_identity &&
          !row.missing_producer,
      ),
  };
}
