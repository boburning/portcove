/** Public binding shape only. This parser authenticates neither the prior feed
 * nor a coordinator, and it never grants a metadata signing capability. */
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectMetadataRenewalDescriptor,
  inspectPublishedMetadata,
  assertMetadataRenewalBinding,
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
    "checkpoint,descriptor,mode,namespace,previous_site_pins,public_source_commit,setup_plan_sha256",
  );
  exact(binding, "descriptor_sha256,kind,records_sha256");
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
    published.publication.site_generation_sha256 !==
      context.previous_site_pins.site_generation_sha256
  )
    throw new Error("current metadata renewal site generation changed");
  return context.facts.descriptor;
}
