import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectReleaseControlPhase,
  inspectControllerExecutionPurpose,
  inspectControllerPurposePhase,
} from "./release-control-phases.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import { performance } from "node:perf_hooks";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import {
  admitProductionInputReader,
  admitProductionCatalogInputReader,
  admitProductionClassificationWriter,
  admitProductionClassificationObserver,
  readProductionControllerWorkflowBytes,
  admitReviewedInputsWriter,
  readReviewedInputsWorkflowBytes,
} from "./production-controller-admission.mts";
import {
  inspectBoundFixedJobJournalAuthorities,
  inspectBoundSelectedPublicationAuthorities,
  inspectBoundControllerAuthorities,
  inspectBoundCatalogControllerAuthorities,
  inspectNativePrepublicationAuthorities,
  requireFixedControllerJobSourceConfiguration,
  requireControllerJobAuthorityConfiguration,
} from "./release-authority-configuration-contract.mts";
export * from "./release-authority-configuration-contract.mts";

/** Source-bound entry routing, not an executor/control/signing capability. The
 * catalog path retains its existing actual named OIDC check before routing. */
async function readControllerJobSourceConfiguration(
  rawPhase: unknown,
  expectedPurpose?: "application" | "catalog-publication",
) {
  const environment = { ...process.env };
  const purpose = inspectControllerExecutionPurpose(environment.PORTCOVE_EXECUTION_PURPOSE);
  if (expectedPurpose && purpose !== expectedPurpose)
    throw new Error(
      expectedPurpose === "application"
        ? "application job source required"
        : "catalog job source required",
    );
  const phase = inspectControllerPurposePhase(rawPhase, purpose);
  const raw =
    purpose === "application"
      ? environment.PORTCOVE_RELEASE_AUTHORITIES
      : environment.PORTCOVE_CATALOG_AUTHORITIES;
  if (!raw || Buffer.byteLength(raw) > 32768)
    throw new Error("complete fixed job source configuration unavailable");
  const configuration: unknown = JSON.parse(raw);
  const deadline = performance.now() + coordinatorCommandTimeout(15000);
  const workflow = await readProductionControllerWorkflowBytes();
  let source;
  if (purpose === "catalog-publication") {
    const { authenticateCatalogControlReaderJob } =
      await import("./release-live-control-admission.mts");
    const actual = await authenticateCatalogControlReaderJob(environment, workflow, {
      phase,
      deadline,
    });
    if (actual.identity.evidence_scope !== "github.com")
      throw new Error("actual catalog OIDC identity required");
    source = actual.admitted;
  } else {
    source = admitProductionInputReader(
      environment.PORTCOVE_CONTROLLER_ADMISSION,
      environment,
      workflow,
      phase,
    );
  }
  const binding = requireFixedControllerJobSourceConfiguration(
    configuration,
    source,
    phase,
    purpose,
  );
  const recheck = () => {
    const keys = new Set([...Object.keys(environment), ...Object.keys(process.env)]);
    for (const key of keys) {
      if (
        (key.startsWith("GITHUB_") ||
          key.startsWith("PORTCOVE_") ||
          key === "RUNNER_TEMP" ||
          key === "RUNNER_ENVIRONMENT") &&
        environment[key] !== process.env[key]
      )
        throw new Error("fixed job environment changed after source admission");
    }
    requireFixedControllerJobSourceConfiguration(configuration, source, phase, purpose);
    checkCoordinatorDeadline();
  };
  recheck();
  if (performance.now() >= deadline)
    throw new Error("fixed job source original collection deadline exhausted");
  return { binding, recheck, configuration, source };
}
export async function requireControllerJobSourceConfiguration(rawPhase: unknown) {
  const { binding, recheck } = await readControllerJobSourceConfiguration(rawPhase);
  return { binding, recheck };
}
async function readControllerJobAuthorityConfiguration(
  phase: unknown,
  expectedPurpose?: "application" | "catalog-publication",
) {
  const captured = await readControllerJobSourceConfiguration(phase, expectedPurpose);
  const view = requireControllerJobAuthorityConfiguration(
    captured.configuration,
    captured.source,
    phase,
    captured.binding.purpose,
  );
  captured.recheck();
  return view;
}
/** Full source-bound coordinator inputs, not an executor or key capability. */
export async function requireControllerApplicationCoordinatorAuthorities() {
  const view = await readControllerJobAuthorityConfiguration("coordinator");
  if (view.purpose !== "application") throw new Error("application coordinator source required");
  return view;
}
export async function requireControllerApplicationCoordinatorPublicationAuthorities() {
  const view = await requireControllerApplicationCoordinatorAuthorities();
  if (!view.publication) throw new Error("complete coordinator public setup pins required");
  return { ...view, publication: view.publication };
}
export async function requireControllerCatalogCoordinatorAuthorities() {
  const view = await readControllerJobAuthorityConfiguration("coordinator");
  if (view.purpose !== "catalog-publication")
    throw new Error("catalog coordinator source required");
  return view;
}
/** Full original source/configuration, still requiring separate live executor,
 * control, custody and pending-effect checks at each operation boundary. */
export async function requireControllerApplicationJobAuthorities(phase: unknown) {
  const view = await readControllerJobAuthorityConfiguration(phase, "application");
  if (view.purpose !== "application") throw new Error("application job source required");
  return view;
}
export async function requireControllerApplicationJobPublicationAuthorities(phase: unknown) {
  const view = await requireControllerApplicationJobAuthorities(phase);
  if (!view.publication) throw new Error("complete job public setup pins required");
  return { ...view, publication: view.publication };
}
export async function requireControllerCatalogJobAuthorities(phase: unknown) {
  const view = await readControllerJobAuthorityConfiguration(phase, "catalog-publication");
  if (view.purpose !== "catalog-publication") throw new Error("catalog job source required");
  return view;
}
/** Actual source-bound role reader. The existing OIDC executor must separately
 * match this source; token availability and environment claims alone grant no
 * signing, protection, capacity, history or publication acceptance. */
async function readControllerSelectedAuthoritySource(role: CapacityExecutorRole) {
  const environment = { ...process.env };
  const purpose = inspectControllerExecutionPurpose(environment.PORTCOVE_EXECUTION_PURPOSE);
  const configuration =
    purpose === "application"
      ? environment.PORTCOVE_RELEASE_AUTHORITIES
      : environment.PORTCOVE_CATALOG_AUTHORITIES;
  const policy =
    purpose === "application"
      ? environment.PORTCOVE_CONTROLLER_ADMISSION
      : environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION;
  if (!configuration || Buffer.byteLength(configuration) > 32768)
    throw new Error("protected selected fixed-job journal configuration unavailable");
  const phase =
    role === "aggregate-assembly" ? "admission" : role === "payload-signing" ? "payload" : role;
  const source = (
    purpose === "application" ? admitProductionInputReader : admitProductionCatalogInputReader
  )(policy, environment, await readProductionControllerWorkflowBytes(), phase);
  return { configuration, purpose, source } as const;
}

export async function requireControllerFixedJobJournalAuthorities(role: CapacityExecutorRole) {
  const { configuration, purpose, source } = await readControllerSelectedAuthoritySource(role);
  const raw: unknown = JSON.parse(configuration);
  if (isRecord(raw) && raw.schema_version === 4) {
    const selected = inspectBoundSelectedPublicationAuthorities(raw, source, purpose);
    return {
      configuration: selected.configuration.journal,
      purpose,
      source,
      configuration_sha256: selected.journal_configuration_sha256,
      authority_configuration_sha256: selected.configuration_sha256,
    };
  }
  const selected = inspectBoundFixedJobJournalAuthorities(configuration, source, purpose);
  return {
    configuration: selected,
    purpose,
    source,
    configuration_sha256: releaseCanonicalDigest(selected),
  };
}

/** Actual immutable workflow/configuration source read, not live OIDC/control
 * acceptance. Callers must still use the existing authenticated role consumer.
 * Journal-only schema3 deliberately cannot satisfy these full-scope readers. */
async function requireControllerSelectedPublicationAuthorities(role: CapacityExecutorRole) {
  const { configuration, purpose, source } = await readControllerSelectedAuthoritySource(role);
  return {
    ...inspectBoundSelectedPublicationAuthorities(JSON.parse(configuration), source, purpose),
    source,
  };
}
export async function requireControllerSelectedApplicationAuthorities(role: CapacityExecutorRole) {
  const selected = await requireControllerSelectedPublicationAuthorities(role);
  if (selected.configuration.purpose !== "application")
    throw new Error("selected application authority requires application source");
  return { ...selected, configuration: selected.configuration };
}
export async function requireControllerSelectedCatalogAuthorities(role: CapacityExecutorRole) {
  const selected = await requireControllerSelectedPublicationAuthorities(role);
  if (selected.configuration.purpose !== "catalog-publication")
    throw new Error("selected catalog authority requires catalog source");
  return { ...selected, configuration: selected.configuration };
}

/** Fixed hosted caller only. Protected owner configuration is digest-bound to
 * the ratified immutable controller policy. This source/configuration check is
 * additional to the existing live OIDC/protections/control and capacity gates. */
export async function requireControllerReleaseAuthorities(phase: unknown) {
  const configuration = process.env.PORTCOVE_RELEASE_AUTHORITIES;
  const policy = process.env.PORTCOVE_CONTROLLER_ADMISSION;
  if (!configuration || Buffer.byteLength(configuration) > 32 * 1024)
    throw new Error("protected release authority configuration unavailable");
  const source = admitProductionInputReader(
    policy,
    process.env,
    await readProductionControllerWorkflowBytes(),
    phase,
  );
  return inspectBoundControllerAuthorities(configuration, source);
}

export async function requireControllerPublicationAuthorities(phase: unknown) {
  const authorities = await requireControllerReleaseAuthorities(phase);
  if (!authorities.publication)
    throw new Error(
      "complete signing workflow requires ratified public Root, Targets, payload registry and setup pins",
    );
  return { ...authorities, publication: authorities.publication };
}

/** The fixed prepublication reader may select the temporal contract only from
 * the existing protected configuration and controller/grant digest. Parsed
 * report/candidate fields cannot select it, and schema1 has no default opt-in. */
export async function requireControllerNativePrepublicationAuthorities() {
  return inspectNativePrepublicationAuthorities(
    await requireControllerReleaseAuthorities("release-publication"),
  );
}
async function productionClassificationAuthorities(role: "writer" | "observer") {
  const configuration = process.env.PORTCOVE_RELEASE_AUTHORITIES;
  if (!configuration || Buffer.byteLength(configuration) > 32 * 1024)
    throw new Error("protected release authority configuration unavailable");
  const admit =
    role === "writer" ? admitProductionClassificationWriter : admitProductionClassificationObserver;
  const source = admit(
    process.env.PORTCOVE_CONTROLLER_ADMISSION,
    process.env,
    await readProductionControllerWorkflowBytes(),
  );
  return inspectBoundControllerAuthorities(configuration, source);
}
export function requireProductionClassificationWriterAuthorities() {
  return productionClassificationAuthorities("writer");
}
export function requireProductionClassificationObserverAuthorities() {
  return productionClassificationAuthorities("observer");
}
/** Selected D1 source only. The actual named writer/observer OIDC verifier is
 * still mandatory before credentials or a persistence capability are used. */
export async function requireSelectedProductionClassificationAuthorities(
  role: "writer" | "observer",
) {
  const environment = { ...process.env };
  const configuration = environment.PORTCOVE_RELEASE_AUTHORITIES;
  if (!configuration || Buffer.byteLength(configuration) > 32768)
    throw new Error("protected selected classification configuration unavailable");
  const admit =
    role === "writer" ? admitProductionClassificationWriter : admitProductionClassificationObserver;
  const source = admit(
    environment.PORTCOVE_CONTROLLER_ADMISSION,
    environment,
    await readProductionControllerWorkflowBytes(),
  );
  const selected = inspectBoundSelectedPublicationAuthorities(
    JSON.parse(configuration),
    source,
    "application",
  );
  if (selected.configuration.purpose !== "application")
    throw new Error("selected application classification authority required");
  return { ...selected, configuration: selected.configuration, source };
}

/** Fixed classification writer only. Its separate workflow must be admitted
 * against its own byte digest; production workflow admission cannot substitute.
 * Actual writer OIDC and isolated protection evidence remain mandatory. */
export async function requireReviewedInputsReleaseAuthorities() {
  const configuration = process.env.PORTCOVE_RELEASE_AUTHORITIES;
  if (!configuration || Buffer.byteLength(configuration) > 32 * 1024)
    throw new Error("protected release authority configuration unavailable");
  const source = admitReviewedInputsWriter(
    process.env.PORTCOVE_CONTROLLER_ADMISSION,
    process.env,
    await readReviewedInputsWorkflowBytes(),
  );
  return inspectBoundControllerAuthorities(configuration, source);
}

export async function requireControllerCatalogPublicationAuthorities(phase: unknown) {
  const deadline = performance.now() + coordinatorCommandTimeout(15000);
  const env = { ...process.env },
    raw = env.PORTCOVE_CATALOG_AUTHORITIES;
  if (!raw || Buffer.byteLength(raw) > 32 * 1024)
    throw new Error("protected catalog authority configuration unavailable");
  const { authenticateCatalogControlReaderJob } =
    await import("./release-live-control-admission.mts");
  const actual = await authenticateCatalogControlReaderJob(
    env,
    await readProductionControllerWorkflowBytes(),
    { phase: inspectReleaseControlPhase(phase), deadline },
  );
  if (actual.identity.evidence_scope !== "github.com")
    throw new Error("actual catalog OIDC identity required");
  const result = inspectBoundCatalogControllerAuthorities(JSON.parse(raw), actual.admitted);
  if (performance.now() >= deadline)
    throw new Error("catalog authority original phase deadline exhausted");
  return result;
}
