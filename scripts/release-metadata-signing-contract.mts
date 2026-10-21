import { createHash } from "node:crypto";
/** Public binding shape only. This parser authenticates neither the prior feed
 * nor a coordinator, and it never grants a metadata signing capability. */
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  currentPublishedSite,
  currentApplicationSitePins,
} from "./release-catalog-metadata-contract.mts";
import {
  inspectMetadataRenewalDescriptor,
  inspectPublishedMetadata,
  assertMetadataRenewalBinding,
  inspectMetadataBootstrapDescriptor,
  assertMetadataBootstrapBinding,
} from "./release-metadata-contract.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { isRecord } from "./runtime-values.mts";
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("metadata signing binding schema differs");
}
function sha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("metadata signing digest differs");
}
/** Inert catalog-only prior locator; actual callers must authenticate custody and setup. */
export function inspectBootstrapCatalogPins(raw: unknown) {
  exact(raw, "kind,repository_sha256,root_sha256,site_generation_sha256");
  if (raw.kind !== "catalog-only")
    throw new Error("explicit catalog-only bootstrap prior required");
  for (const key of ["repository_sha256", "root_sha256", "site_generation_sha256"] as const)
    sha(raw[key]);
  return {
    kind: "catalog-only" as const,
    repository_sha256: raw.repository_sha256 as string,
    root_sha256: raw.root_sha256 as string,
    site_generation_sha256: raw.site_generation_sha256 as string,
  };
}
/** Same-journal component absence and exact global cursor, never absence inferred from URLs. */
export function assertBootstrapSiteBaseline(raw: unknown, input: Record<string, unknown>) {
  const site = currentPublishedSite(input);
  if (inspectPublishedMetadata(input.published_metadata) || site?.components.application)
    throw new Error("application bootstrap closed by existing application history");
  if (raw === null) {
    if (site !== null) throw new Error("whole-404 bootstrap cannot adopt an existing catalog site");
    return null;
  }
  const pins = inspectBootstrapCatalogPins(raw);
  if (
    !site ||
    !site.components.catalog ||
    site.generation_sha256 !== pins.site_generation_sha256 ||
    site.components.catalog.root_sha256 !== pins.root_sha256 ||
    site.components.catalog.repository_sha256 !== pins.repository_sha256
  )
    throw new Error("bootstrap catalog prior differs from same-journal component/cursor");
  return pins;
}
export function inspectMetadataSigningBinding(
  rawFacts: unknown,
  rawBinding: unknown,
  rawPins: unknown,
) {
  const facts: unknown = structuredClone(rawFacts),
    binding: unknown = structuredClone(rawBinding),
    pins: unknown = structuredClone(rawPins);
  exact(
    facts,
    isRecord(facts) && Object.hasOwn(facts, "initial_site_preimage")
      ? "catalog_readback_sha256,checkpoint,descriptor,initial_site_preimage,mode,namespace,previous_site_pins,public_source_commit,setup_plan_sha256"
      : "checkpoint,descriptor,mode,namespace,previous_site_pins,public_source_commit,setup_plan_sha256",
  );
  exact(binding, "descriptor_sha256,kind,records_sha256");
  if (facts.mode === "bootstrap") {
    const descriptor = inspectMetadataBootstrapDescriptor(facts.descriptor);
    if (
      digest(pins) !== digest(facts.previous_site_pins) ||
      binding.kind !== "metadata-bootstrap" ||
      binding.descriptor_sha256 !== digest(descriptor) ||
      binding.records_sha256 !== digest([]) ||
      descriptor.initial_records_sha256 !== binding.records_sha256 ||
      facts.setup_plan_sha256 !== descriptor.setup_plan_sha256 ||
      typeof facts.checkpoint !== "string" ||
      !/^[a-f0-9]{40}$/u.test(facts.checkpoint) ||
      typeof facts.public_source_commit !== "string" ||
      !/^[a-f0-9]{40}$/u.test(facts.public_source_commit)
    )
      throw new Error("initial metadata context prior or explicit empty setup binding differs");
    const prior = pins === null ? null : inspectBootstrapCatalogPins(pins);
    const preimage = facts.initial_site_preimage;
    if (prior) {
      sha(facts.catalog_readback_sha256);
      if (
        typeof preimage !== "string" ||
        Buffer.byteLength(preimage) > 128 * 1024 ||
        createHash("sha256").update(preimage).digest("hex") !==
          descriptor.initial_site_preimage_sha256
      )
        throw new Error("catalog-only bootstrap requires exact setup preimage bytes");
      const raw: unknown = JSON.parse(preimage);
      if (
        !isRecord(raw) ||
        raw.kind !== "catalog-only-application-site-preimage" ||
        digest(raw.pins) !== digest(prior)
      )
        throw new Error("catalog-only context prior differs from retained preimage");
    } else if (Object.hasOwn(facts, "initial_site_preimage"))
      throw new Error("whole404 context cannot add catalog setup fields");
    if (prior?.root_sha256 === descriptor.root_sha256)
      throw new Error("application/catalog roots must differ");
    return {
      facts: {
        mode: "bootstrap" as const,
        namespace: inspectCoordinatorRemoteNamespace({
          schema_version: 1,
          namespace: facts.namespace,
        }),
        descriptor,
        checkpoint: facts.checkpoint,
        previous_site_pins: prior,
        ...(prior
          ? {
              initial_site_preimage: preimage as string,
              catalog_readback_sha256: facts.catalog_readback_sha256 as string,
            }
          : {}),
        setup_plan_sha256: descriptor.setup_plan_sha256,
        public_source_commit: facts.public_source_commit,
      },
      binding,
      previous_site_pins: prior,
      authority: "none" as const,
    };
  }
  exact(pins, "repository_sha256,root_sha256,site_generation_sha256");
  const descriptor = inspectMetadataRenewalDescriptor(facts.descriptor);
  for (const value of Object.values(pins)) sha(value);
  for (const value of [facts.setup_plan_sha256, binding.descriptor_sha256, binding.records_sha256])
    sha(value);
  sha(facts.setup_plan_sha256);
  const namespace = inspectCoordinatorRemoteNamespace({
    schema_version: 1,
    namespace: facts.namespace,
  });
  if (
    Object.hasOwn(facts, "initial_site_preimage") ||
    facts.mode !== "renewal" ||
    binding.kind !== "metadata-renewal" ||
    typeof facts.checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(facts.checkpoint) ||
    typeof facts.public_source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(facts.public_source_commit) ||
    digest(facts.previous_site_pins) !== digest(pins) ||
    descriptor.root_sha256 !== pins.root_sha256 ||
    descriptor.prior_repository_sha256 !== pins.repository_sha256 ||
    binding.descriptor_sha256 !== digest(descriptor) ||
    binding.records_sha256 !== descriptor.unchanged_records_sha256
  )
    throw new Error("metadata renewal context differs from its exact prior/descriptor binding");
  return {
    facts: {
      mode: "renewal" as const,
      namespace,
      descriptor,
      checkpoint: facts.checkpoint,
      previous_site_pins: pins,
      setup_plan_sha256: facts.setup_plan_sha256,
      public_source_commit: facts.public_source_commit,
    },
    binding,
    previous_site_pins: pins,
    authority: "none" as const,
  };
}
/** Current journal integrity only. A caller still needs actual context custody,
 * its own authenticated role, current maintenance controls and owned pending. */
function metadataSigningNow() {
  const [base, fraction = ""] = new Date().toISOString().slice(0, -1).split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return `${base}${trimmed ? `.${trimmed}` : ""}Z`;
}
export function inspectMetadataSigningReservation(
  rawFacts: unknown,
  rawBinding: unknown,
  rawPins: unknown,
  rawState: unknown,
  now = metadataSigningNow(),
) {
  const context = inspectMetadataSigningBinding(rawFacts, rawBinding, rawPins);
  if (context.facts.mode === "bootstrap") {
    if (
      !isRecord(rawState) ||
      !isRecord(rawState.input) ||
      digest(rawState.input.metadata_bootstrap) !== digest(context.facts.descriptor)
    )
      throw new Error("current initial metadata opportunity changed");
    assertBootstrapSiteBaseline(context.previous_site_pins, rawState.input);
    assertMetadataBootstrapBinding(
      context.facts.descriptor,
      inspectPublishedMetadata(rawState.input.published_metadata),
      now,
    );
    return context.facts.descriptor;
  }
  if (
    !isRecord(rawState) ||
    !isRecord(rawState.input) ||
    digest(rawState.input.metadata_renewal) !== digest(context.facts.descriptor)
  )
    throw new Error("current metadata renewal opportunity changed");
  const published = inspectPublishedMetadata(rawState.input.published_metadata);
  assertMetadataRenewalBinding(context.facts.descriptor, published, now);
  if (
    !published ||
    !context.previous_site_pins ||
    currentApplicationSitePins(rawState.input).site_generation_sha256 !==
      context.previous_site_pins.site_generation_sha256
  )
    throw new Error("current metadata renewal site generation changed");
  return context.facts.descriptor;
}
