import { createHash } from "node:crypto";
/** Closed configuration/source contracts only. No environment reads or live controller execution. */
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectCatalogCoreReport } from "./release-catalog-publication-contract.mts";
import {
  inspectReleaseControlPhase,
  inspectControllerPurposePhase,
  releaseControlPhaseProfile,
  semanticReviewCheckName,
} from "./release-control-phases.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { inspectInitialProofRisk706 } from "./linux-beta-risk-706-profile.mts";
import {
  nativePrepublicationProfile,
  inspectNativeQualificationHarnessPath,
  inspectNativeQualificationAccount,
  inspectNativeQualificationCompatibility,
} from "./release-native-qualification-contract.mts";
import {
  requireAdmittedProductionSource,
  requireAdmittedProductionObserverSource,
  type admitProductionInputReader,
} from "./production-controller-admission.mts";
const roles = [
  "semantic",
  "classification",
  "native_qualification",
  "protection_observer",
  "coordinator_journal",
  "dispatch",
  "release_publication",
] as const;
const platforms = ["windows-x86_64", "linux-x86_64"] as const;
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("release authority configuration schema differs");
}
function hex(value: unknown, length: number): string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error("release authority source identity absent");
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("release authority provider identity unavailable");
  return value;
}
function text(value: unknown, maximum = 184): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > maximum ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("release authority fixed text unavailable");
  return value;
}
function minimumVersion(value: unknown, minimum: string) {
  const declared = text(value, 64);
  if (!/^[0-9]{1,10}(?:\.[0-9]{1,10}){1,3}$/u.test(declared))
    throw new Error("release authority engine minimum is invalid");
  const parts = declared.split(".").map(BigInt),
    floor = minimum.split(".").map(BigInt);
  for (let index = 0; index < Math.max(parts.length, floor.length); index++) {
    if ((parts[index] ?? 0n) < (floor[index] ?? 0n))
      throw new Error("release authority engine floor weakened");
    if ((parts[index] ?? 0n) > (floor[index] ?? 0n)) return;
  }
}

/** Public data locations under the existing ratified configuration digest.
 * Neither parsing these pins nor downloading their bytes grants signing. */
export function inspectPublicationAuthorities(raw: unknown, schemaVersion: unknown = 1) {
  const value: unknown = structuredClone(raw);
  exact(value, "initial_site_preimage_sha256,public_source,setup_plan_sha256");
  const hasPreimage =
    isRecord(value.public_source) && Object.hasOwn(value.public_source, "initial_site_preimage");
  if (hasPreimage && schemaVersion !== 2)
    throw new Error("historical setup preimage locator requires explicit schema2 configuration");
  exact(
    value.public_source,
    hasPreimage
      ? "commit,initial_site_preimage,offline_targets,payload_key_registry,root"
      : "commit,offline_targets,payload_key_registry,root",
  );
  const source = value.public_source;
  const filePin = (file: unknown) => {
    exact(file, "bytes,path,sha256");
    if (
      typeof file.path !== "string" ||
      file.path.length > 256 ||
      !file.path.endsWith(".json") ||
      file.path.split("/").length > 8 ||
      !file.path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)) ||
      positive(file.bytes) > 1024 * 1024
    )
      throw new Error("publication public data path or byte bound differs");
    return { path: file.path, bytes: Number(file.bytes), sha256: hex(file.sha256, 64) };
  };
  const files = Object.fromEntries(
    (["root", "offline_targets", "payload_key_registry"] as const).map((name) => {
      return [name, filePin(source[name])];
    }),
  ) as Record<
    "root" | "offline_targets" | "payload_key_registry",
    { path: string; bytes: number; sha256: string }
  >;
  if (new Set(Object.values(files).map((file) => file.path)).size !== 3)
    throw new Error("publication public data paths are conflated");
  const initial = hasPreimage ? filePin(source.initial_site_preimage) : undefined;
  if (
    initial &&
    (initial.sha256 !== hex(value.initial_site_preimage_sha256, 64) ||
      Object.values(files).some((file) => file.path === initial.path))
  )
    throw new Error("historical setup preimage locator differs from ratified preimage");
  return {
    public_source: {
      commit: hex(source.commit, 40),
      ...files,
      ...(initial ? { initial_site_preimage: initial } : {}),
    },
    setup_plan_sha256: hex(value.setup_plan_sha256, 64),
    initial_site_preimage_sha256: hex(value.initial_site_preimage_sha256, 64),
  };
}

/** Configuration integrity only. Setup records actual generated IDs and custody
 * under the approved scope; parsing or a supplied digest never appoints them.
 * Native dynamic Check/invocation/candidate fields are deliberately excluded. */
export function inspectReleaseAuthorityConfiguration(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(
    value,
    [
      "apps",
      "namespace",
      "native",
      "repository_id",
      "schema_version",
      ...(isRecord(value) && Object.hasOwn(value, "publication") ? ["publication"] : []),
      ...(isRecord(value) && value.schema_version === 2 ? ["native_prepublication_profile"] : []),
      ...(isRecord(value) && Object.hasOwn(value, "linux_risk_profile")
        ? ["linux_risk_profile"]
        : []),
    ]
      .sort()
      .join(","),
  );
  if (
    (value.schema_version !== 1 && value.schema_version !== 2) ||
    value.repository_id !== 1354613114 ||
    Buffer.byteLength(JSON.stringify(value)) > 32 * 1024
  )
    throw new Error("release authority repository or byte bound differs");
  if (value.linux_risk_profile !== undefined && value.schema_version !== 2)
    throw new Error("initial-proof risk profile requires explicit ratified schema2 configuration");
  if (
    value.schema_version === 2 &&
    value.native_prepublication_profile !== nativePrepublicationProfile
  )
    throw new Error("ratified native prepublication profile differs");
  const namespace = inspectCoordinatorRemoteNamespace({
    schema_version: 1,
    namespace: value.namespace,
  });
  exact(value.apps, [...roles].sort().join(","));
  const appRecords = value.apps;
  const apps = Object.fromEntries(
    roles.map((role) => {
      const app = appRecords[role];
      exact(
        app,
        role === "dispatch" ? "actor_id,app_id,installation_id" : "app_id,installation_id",
      );
      if (
        role === "dispatch" &&
        (typeof app.actor_id !== "string" ||
          !/^[1-9][0-9]{0,15}$/u.test(app.actor_id) ||
          ["43177418", "41898282"].includes(app.actor_id))
      )
        throw new Error(
          "release dispatch actor must be the independently observed dedicated App bot",
        );
      return [
        role,
        {
          app_id: positive(app.app_id),
          installation_id: positive(app.installation_id),
          ...(role === "dispatch" ? { actor_id: String(app.actor_id) } : {}),
        },
      ];
    }),
  ) as Record<(typeof roles)[number], { app_id: number; installation_id: number }> & {
    dispatch: { app_id: number; installation_id: number; actor_id: string };
  };
  if (
    new Set([15368, ...roles.map((role) => apps[role].app_id)]).size !== roles.length + 1 ||
    new Set(roles.map((role) => apps[role].installation_id)).size !== roles.length
  )
    throw new Error("release authority roles or generic Actions issuer are conflated");
  exact(value.native, [...platforms].sort().join(","));
  const nativeRecords = value.native;
  const native = Object.fromEntries(
    platforms.map((platform) => {
      const expected = nativeRecords[platform];
      exact(expected, "compatibility,host,producer");
      exact(expected.producer, "harness,source_commit,source_tree");
      exact(expected.producer.harness, "path,sha256");
      inspectNativeQualificationHarnessPath(expected.producer.harness.path);
      if (!isRecord(expected.host) || !isRecord(expected.compatibility))
        throw new Error("release authority native fixed expectations absent");
      const host = expected.host;
      exact(host, "account,engine,machine_id_sha256,minimum_platform,qualification_profile");
      hex(host.machine_id_sha256, 64);
      text(host.qualification_profile, 128);
      if (
        host.minimum_platform !==
        (platform === "windows-x86_64" ? "windows-11-26h2-x64" : "ubuntu-24.04-x64")
      )
        throw new Error("release authority minimum platform differs from initial beta");
      const crossHost = isRecord(host.account) && host.account.kind === "windows-wsl-uid";
      if (crossHost) {
        if (platform !== "linux-x86_64")
          throw new Error("WSL account belongs only to Linux package qualification");
        inspectNativeQualificationAccount(host.account);
      } else {
        exact(host.account, "broker,kind,qualification");
        const accountKind = platform === "windows-x86_64" ? "windows-sid" : "linux-uid";
        const accountPattern =
          accountKind === "windows-sid" ? /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u : /^[1-9][0-9]{0,9}$/u;
        if (
          host.account.kind !== accountKind ||
          host.account.broker === host.account.qualification ||
          !accountPattern.test(text(host.account.broker)) ||
          !accountPattern.test(text(host.account.qualification))
        )
          throw new Error("release authority native accounts are unconfigured or conflated");
      }
      exact(host.engine, "minimum_version,name");
      if (host.engine.name !== (platform === "windows-x86_64" ? "WebView2" : "WebKitGTK"))
        throw new Error("release authority native engine family differs");
      minimumVersion(
        host.engine.minimum_version,
        platform === "windows-x86_64" ? "155.0.4283.62" : "2.52.6",
      );
      exact(
        expected.compatibility,
        "catalog_formats,cli_protocol,library,minimum_os_version,required_capabilities",
      );
      // The existing native inspector validates host/account, engine floor and
      // compatibility against the actual acquired tuple before any collection.
      return [
        platform,
        {
          producer: {
            source_commit: hex(expected.producer.source_commit, 40),
            source_tree: hex(expected.producer.source_tree, 40),
            harness: {
              path: expected.producer.harness.path,
              sha256: hex(expected.producer.harness.sha256, 64),
            },
          },
          host: structuredClone(expected.host),
          compatibility: structuredClone(expected.compatibility),
        },
      ];
    }),
  ) as Record<
    (typeof platforms)[number],
    {
      producer: {
        source_commit: string;
        source_tree: string;
        harness: { path: string; sha256: string };
      };
      host: Record<string, unknown>;
      compatibility: Record<string, unknown>;
    }
  >;
  return {
    schema_version: value.schema_version,
    ...(value.schema_version === 2
      ? { native_prepublication_profile: nativePrepublicationProfile }
      : {}),
    repository_id: 1354613114 as const,
    namespace,
    ...(value.linux_risk_profile === undefined
      ? {}
      : { linux_risk_profile: inspectInitialProofRisk706(value.linux_risk_profile) }),
    apps,
    native,
    ...(value.publication === undefined
      ? {}
      : { publication: inspectPublicationAuthorities(value.publication, value.schema_version) }),
  };
}
export type ReleaseAuthorityConfiguration = ReturnType<typeof inspectReleaseAuthorityConfiguration>;

/** The selected replacement's journal projection. It deliberately does not
 * satisfy legacy seven-App/native/publisher inspectors. Other consumers must
 * migrate explicitly; parsing this record appoints no key or provider role. */
export function inspectFixedJobJournalAuthorities(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(value, "apps,journal_seed,kind,namespace,repository_id,schema_version,setup_plan_sha256");
  if (
    value.schema_version !== 3 ||
    value.kind !== "two-app-fixed-jobs-v1" ||
    value.repository_id !== 1354613114 ||
    Buffer.byteLength(JSON.stringify(value)) > 32768
  )
    throw new Error("selected fixed-job journal profile/repository/bound differs");
  const namespace = inspectCoordinatorRemoteNamespace({
    schema_version: 1,
    namespace: value.namespace,
  });
  exact(value.apps, "protection_observer,semantic");
  const inspectApp = (rawApp: unknown) => {
    exact(rawApp, "app_id,installation_id");
    return { app_id: positive(rawApp.app_id), installation_id: positive(rawApp.installation_id) };
  };
  const apps = {
    semantic: inspectApp(value.apps.semantic),
    protection_observer: inspectApp(value.apps.protection_observer),
  };
  if (
    new Set([15368, apps.semantic.app_id, apps.protection_observer.app_id]).size !== 3 ||
    apps.semantic.installation_id === apps.protection_observer.installation_id
  )
    throw new Error("selected App identities are conflated with each other or generic Actions");
  exact(value.journal_seed, "checkpoint,state_sha256");
  return {
    schema_version: 3 as const,
    kind: "two-app-fixed-jobs-v1" as const,
    repository_id: 1354613114 as const,
    namespace,
    apps,
    setup_plan_sha256: hex(value.setup_plan_sha256, 64),
    journal_seed: {
      checkpoint: hex(value.journal_seed.checkpoint, 40),
      state_sha256: hex(value.journal_seed.state_sha256, 64),
    },
  };
}

function inspectSelectedHostedNative(raw: unknown) {
  exact(raw, [...platforms].sort().join(","));
  const inspectPlatform = (platform: (typeof platforms)[number]) => {
    const value = raw[platform];
    exact(value, "compatibility,engine,minimum_platform,producer");
    exact(value.producer, "harness,source_commit,source_tree");
    exact(value.producer.harness, "path,sha256");
    exact(value.engine, "minimum_version,name");
    const windows = platform === "windows-x86_64";
    const minimumPlatform = windows ? "windows-11-26h2-x64" : "ubuntu-24.04-x64";
    const engineName = windows ? "WebView2" : "WebKitGTK";
    if (value.minimum_platform !== minimumPlatform || value.engine.name !== engineName)
      throw new Error("selected native minimum platform or engine family differs");
    minimumVersion(value.engine.minimum_version, windows ? "155.0.4283.62" : "2.52.6");
    return {
      minimum_platform: minimumPlatform,
      engine: { name: engineName, minimum_version: text(value.engine.minimum_version, 64) },
      producer: {
        source_commit: hex(value.producer.source_commit, 40),
        source_tree: hex(value.producer.source_tree, 40),
        harness: {
          path: inspectNativeQualificationHarnessPath(value.producer.harness.path),
          sha256: hex(value.producer.harness.sha256, 64),
        },
      },
      compatibility: inspectNativeQualificationCompatibility(value.compatibility),
    };
  };
  return {
    "windows-x86_64": inspectPlatform("windows-x86_64"),
    "linux-x86_64": inspectPlatform("linux-x86_64"),
  };
}

/** Full purpose-scoped selected record. Two measured Apps belong only to its
 * common journal projection. Fixed hosted job identity is verified separately;
 * neither this parser nor a key/configuration digest grants acceptance. */
export function inspectSelectedPublicationAuthorityConfiguration(raw: unknown) {
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    (value.purpose !== "application" && value.purpose !== "catalog-publication")
  )
    throw new Error("selected full authority requires an explicit publication purpose");
  const application = value.purpose === "application";
  exact(
    value,
    [
      "schema_version",
      "kind",
      "purpose",
      "journal",
      ...(application
        ? [
            "hosted_native",
            "native_prepublication_profile",
            "publication",
            ...(Object.hasOwn(value, "linux_risk_profile") ? ["linux_risk_profile"] : []),
          ]
        : ["catalog"]),
    ]
      .sort()
      .join(","),
  );
  if (
    value.schema_version !== 4 ||
    value.kind !== "two-app-fixed-jobs-v1" ||
    Buffer.byteLength(JSON.stringify(value)) > 32768
  )
    throw new Error("selected full authority profile or bound differs");
  const journal = inspectFixedJobJournalAuthorities(value.journal);
  const common = { schema_version: 4 as const, kind: "two-app-fixed-jobs-v1" as const, journal };
  if (application) {
    if (value.native_prepublication_profile !== nativePrepublicationProfile)
      throw new Error("selected native prepublication profile differs");
    const publication = inspectPublicationAuthorities(value.publication, 2);
    if (publication.setup_plan_sha256 !== journal.setup_plan_sha256)
      throw new Error("selected publication setup differs from journal setup");
    return {
      ...common,
      purpose: "application" as const,
      publication,
      native_prepublication_profile: nativePrepublicationProfile,
      hosted_native: inspectSelectedHostedNative(value.hosted_native),
      ...(value.linux_risk_profile === undefined
        ? {}
        : {
            linux_risk_profile: inspectInitialProofRisk706(value.linux_risk_profile),
          }),
    };
  }
  const catalog = inspectCatalogPublisherConfiguration(value.catalog);
  if (catalog.setup_plan_sha256 !== journal.setup_plan_sha256)
    throw new Error("selected catalog setup differs from journal setup");
  return { ...common, purpose: "catalog-publication" as const, catalog };
}

export function inspectBoundSelectedPublicationAuthorities(
  raw: unknown,
  source: { mode: unknown; authority_configuration_sha256?: string; grant_sha256?: string },
  purpose: "application" | "catalog-publication",
) {
  const configuration = inspectSelectedPublicationAuthorityConfiguration(raw);
  if (
    configuration.purpose !== purpose ||
    source.mode !==
      (purpose === "application" ? "bounded-application-release" : "bounded-catalog-publication")
  )
    throw new Error("selected full authority source purpose differs");
  const configuration_sha256 = releaseCanonicalDigest(configuration);
  if (hex(source.authority_configuration_sha256, 64) !== configuration_sha256)
    throw new Error("selected full authority changed after ratification");
  hex(source.grant_sha256, 64);
  return {
    configuration,
    configuration_sha256,
    journal_configuration_sha256: releaseCanonicalDigest(configuration.journal),
  };
}

function boundInputRoles(
  raw: unknown,
  source: ReturnType<typeof admitProductionInputReader>,
  purpose: "application" | "catalog-publication",
) {
  if (isRecord(raw) && (raw.schema_version === 4 || raw.kind === "two-app-fixed-jobs-v1")) {
    const selected = inspectBoundSelectedPublicationAuthorities(raw, source, purpose);
    const observer = selected.configuration.journal.apps.protection_observer;
    return {
      classification_transport: "fixed-job" as const,
      protection_app_id: observer.app_id,
      protection_installation_id: observer.installation_id,
      configuration_sha256: selected.configuration_sha256,
    };
  }
  const legacy =
    purpose === "application"
      ? inspectBoundControllerAuthorities(JSON.stringify(raw), source)
      : inspectBoundCatalogControllerAuthorities(raw, source);
  return {
    classification_transport: "legacy-app" as const,
    protection_app_id: legacy.apps.protection_observer.app_id,
    protection_installation_id: legacy.apps.protection_observer.installation_id,
    configuration_sha256: source.authority_configuration_sha256!,
  };
}
/** Public role locators only, derived by the actual fixed admission job. No
 * projection is accepted as a grant, credential or live observer identity. */
export function requireControllerInputRoleConfiguration(
  raw: unknown,
  source: unknown,
  purpose: "application" | "catalog-publication",
) {
  requireAdmittedProductionSource(source, "admission", purpose);
  return boundInputRoles(raw, source, purpose);
}
/** Fixed entry routing only. The original source and complete purpose record
 * are mandatory even when a caller needs only namespace and actor locators. */
export function requireFixedControllerJobSourceConfiguration(
  raw: unknown,
  source: unknown,
  phase: ReturnType<typeof inspectReleaseControlPhase>,
  purpose: "application" | "catalog-publication",
) {
  inspectControllerPurposePhase(phase, purpose);
  requireAdmittedProductionSource(source, releaseControlPhaseProfile(phase).reader_job, purpose);
  const selected =
    isRecord(raw) && (raw.schema_version === 4 || raw.kind === "two-app-fixed-jobs-v1");
  const namespace = selected
    ? inspectBoundSelectedPublicationAuthorities(raw, source, purpose).configuration.journal
        .namespace
    : (purpose === "application"
        ? inspectBoundControllerAuthorities(JSON.stringify(raw), source)
        : inspectBoundCatalogControllerAuthorities(raw, source)
      ).namespace;
  return Object.freeze({
    purpose,
    namespace,
    actor_id: source.actor_id,
    authority_configuration_sha256: source.authority_configuration_sha256!,
    grant_sha256: source.grant_sha256!,
    controller_revision: source.revision,
    controller_ref: source.execution_ref,
    run_id: source.run_id,
    run_attempt: source.run_attempt,
  });
}
/** Inert fixed-job inputs only. Retain the complete original configuration
 * for publisher assertions; a view never supplies executor/control/key authority. */
export function requireControllerJobAuthorityConfiguration(
  raw: unknown,
  source: unknown,
  rawPhase: unknown,
  purpose: "application" | "catalog-publication",
) {
  const phase = inspectControllerPurposePhase(rawPhase, purpose);
  requireAdmittedProductionSource(source, releaseControlPhaseProfile(phase).reader_job, purpose);
  const admitted = source;
  const binding = requireFixedControllerJobSourceConfiguration(raw, admitted, phase, purpose);
  const selected =
    isRecord(raw) && (raw.schema_version === 4 || raw.kind === "two-app-fixed-jobs-v1");
  if (selected) {
    const { configuration } = inspectBoundSelectedPublicationAuthorities(raw, admitted, purpose);
    const common = {
      source: binding,
      namespace: binding.namespace,
      configuration_sha256: binding.authority_configuration_sha256,
      dispatch_actor_id: binding.actor_id,
      semantic_producer: {
        schema_version: 2 as const,
        purpose,
        review_app_id: configuration.journal.apps.semantic.app_id,
        review_check_name: semanticReviewCheckName,
      },
    };
    return configuration.purpose === "application"
      ? {
          ...common,
          purpose: configuration.purpose,
          configuration,
          publication: configuration.publication,
        }
      : {
          ...common,
          purpose: configuration.purpose,
          configuration,
          catalog: configuration.catalog,
        };
  }
  if (purpose === "catalog-publication") {
    const configuration = inspectBoundCatalogControllerAuthorities(raw, admitted);
    return {
      source: binding,
      purpose,
      namespace: configuration.namespace,
      configuration_sha256: configuration.configuration_sha256,
      dispatch_actor_id: configuration.apps.dispatch.actor_id,
      configuration,
      catalog: configuration.catalog,
      semantic_producer: {
        schema_version: 1 as const,
        review_app_id: configuration.apps.semantic.app_id,
        writer_app_id: configuration.apps.classification.app_id,
        review_check_name: semanticReviewCheckName,
      },
    };
  }
  const configuration = inspectBoundControllerAuthorities(JSON.stringify(raw), admitted);
  return {
    source: binding,
    purpose,
    namespace: configuration.namespace,
    configuration_sha256: binding.authority_configuration_sha256,
    dispatch_actor_id: configuration.apps.dispatch.actor_id,
    configuration,
    publication: configuration.publication,
    semantic_producer: {
      schema_version: 1 as const,
      review_app_id: configuration.apps.semantic.app_id,
      writer_app_id: configuration.apps.classification.app_id,
      review_check_name: semanticReviewCheckName,
    },
  };
}

export function requireCoordinatorAuthorityConfiguration(
  raw: unknown,
  source: unknown,
  purpose: "application" | "catalog-publication",
) {
  return requireControllerJobAuthorityConfiguration(raw, source, "coordinator", purpose);
}

/** Local routing-byte linkage only, never an imported grant or executor. The
 * caller must supply its freshly validated original full source binding. */
export function fixedControllerConfigurationSource(
  operation: string,
  source: ReturnType<typeof requireFixedControllerJobSourceConfiguration>,
  bytes: Uint8Array,
) {
  return {
    schema_version: 1,
    operation,
    source,
    configuration_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export function requireFixedControllerConfigurationSource(
  raw: unknown,
  operation: string,
  source: ReturnType<typeof requireFixedControllerJobSourceConfiguration>,
  bytes: Uint8Array,
) {
  const expected = fixedControllerConfigurationSource(operation, source, bytes);
  if (releaseCanonicalDigest(raw) !== releaseCanonicalDigest(expected))
    throw new Error("fixed job configuration differs from its original full source binding");
}
/** Rechecked by the observer before mint readiness and by its collector. */
export function requireProtectionObserverSourceConfiguration(
  raw: unknown,
  source: unknown,
  phase: "classification" | ReturnType<typeof inspectReleaseControlPhase>,
  purpose: "application" | "catalog-publication",
) {
  if (phase === "classification" && purpose !== "application")
    throw new Error("catalog has no classification observer");
  requireAdmittedProductionObserverSource(source, phase, purpose);
  return boundInputRoles(raw, source, purpose);
}

export function inspectBoundFixedJobJournalAuthorities(
  configuration: string,
  source: ReturnType<typeof admitProductionInputReader>,
  purpose: "application" | "catalog-publication",
) {
  if (
    source.mode !==
      (purpose === "application" ? "bounded-application-release" : "bounded-catalog-publication") ||
    !source.authority_configuration_sha256 ||
    !source.grant_sha256 ||
    Buffer.byteLength(configuration) > 32768
  )
    throw new Error("bounded source and protected fixed-job configuration required");
  const result = inspectFixedJobJournalAuthorities(JSON.parse(configuration));
  if (releaseCanonicalDigest(result) !== source.authority_configuration_sha256)
    throw new Error("selected fixed-job journal purpose or ratified configuration changed");
  return result;
}

/** Configuration projection only. The live getter separately binds its digest
 * to the actual protected controller source and ratified grant. */
export function inspectNativePrepublicationAuthorities(raw: unknown) {
  const authorities = inspectReleaseAuthorityConfiguration(raw);
  if (
    authorities.schema_version !== 2 ||
    authorities.native_prepublication_profile !== nativePrepublicationProfile
  )
    throw new Error("ratified signed package compatibility profile required");
  return authorities;
}

/** Named complete-controller D1 configuration. The writer and observer still
 * authenticate distinct actual OIDC jobs before their respective App is used. */
export function inspectBoundControllerAuthorities(
  configuration: string,
  source: ReturnType<typeof admitProductionInputReader>,
) {
  if (
    source.mode !== "bounded-application-release" ||
    !source.authority_configuration_sha256 ||
    !source.grant_sha256
  )
    throw new Error("admission-only source cannot appoint release authority");
  const result = inspectReleaseAuthorityConfiguration(JSON.parse(configuration));
  if (releaseCanonicalDigest(result) !== source.authority_configuration_sha256)
    throw new Error("release authority configuration changed after ratification");
  if (result.apps.dispatch.actor_id !== source.actor_id)
    throw new Error(
      "configured automatic dispatch actor differs from ratified controller principal",
    );
  return structuredClone(result);
}

const catalogApps = [
  "semantic",
  "classification",
  "protection_observer",
  "coordinator_journal",
  "dispatch",
] as const;
const catalogOperations = ["install", "update", "prepare", "launch"] as const;
function scopeIdentity(raw: unknown) {
  const value = text(raw, 128);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value))
    throw new Error("catalog publisher identity differs");
  return value;
}
function uniqueValues<T>(raw: unknown, maximum: number, inspect: (value: unknown) => T): T[] {
  if (!Array.isArray(raw) || raw.length > maximum)
    throw new Error("catalog scope list bound differs");
  const result = raw.map(inspect);
  if (new Set(result).size !== result.length) throw new Error("catalog scope list duplicates");
  return result;
}
function catalogFilePin(raw: unknown) {
  exact(raw, "bytes,path,sha256");
  const filename = text(raw.path, 256);
  if (
    !filename.endsWith(".json") ||
    filename.split("/").length > 8 ||
    !filename.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)) ||
    positive(raw.bytes) > 1024 * 1024
  )
    throw new Error("catalog public pin differs");
  return { path: filename, bytes: Number(raw.bytes), sha256: hex(raw.sha256, 64) };
}
/** Inert appointments only. This configuration cannot appoint application
 * native, payload, Release or application TUF roles. No private keys occur. */
export function inspectCatalogAuthorityConfiguration(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(value, "apps,catalog,kind,namespace,repository_id,schema_version");
  if (
    value.schema_version !== 1 ||
    value.kind !== "catalog-publication-authorities" ||
    value.repository_id !== 1354613114 ||
    Buffer.byteLength(JSON.stringify(value)) > 32 * 1024
  )
    throw new Error("catalog authority purpose/repository/bound differs");
  exact(value.apps, [...catalogApps].sort().join(","));
  const appRecords = value.apps;
  const apps = Object.fromEntries(
    catalogApps.map((role) => {
      const app = appRecords[role];
      exact(
        app,
        role === "dispatch" ? "actor_id,app_id,installation_id" : "app_id,installation_id",
      );
      if (
        role === "dispatch" &&
        (typeof app.actor_id !== "string" ||
          !/^[1-9][0-9]{0,15}$/u.test(app.actor_id) ||
          ["43177418", "41898282"].includes(app.actor_id))
      )
        throw new Error("catalog dispatch actor differs");
      return [
        role,
        {
          app_id: positive(app.app_id),
          installation_id: positive(app.installation_id),
          ...(role === "dispatch" ? { actor_id: String(app.actor_id) } : {}),
        },
      ];
    }),
  ) as Record<(typeof catalogApps)[number], { app_id: number; installation_id: number }> & {
    dispatch: { app_id: number; installation_id: number; actor_id: string };
  };
  if (
    new Set([15368, ...catalogApps.map((role) => apps[role].app_id)]).size !==
      catalogApps.length + 1 ||
    new Set(catalogApps.map((role) => apps[role].installation_id)).size !== catalogApps.length
  )
    throw new Error("catalog issuer/writer/observer/journal/dispatch identities conflated");
  return {
    schema_version: 1 as const,
    kind: "catalog-publication-authorities" as const,
    namespace: inspectCoordinatorRemoteNamespace({ schema_version: 1, namespace: value.namespace }),
    repository_id: 1354613114 as const,
    apps,
    catalog: inspectCatalogPublisherConfiguration(value.catalog),
  };
}

/** Purpose scope only, shared by legacy and selected configuration readers. */
export function inspectCatalogPublisherConfiguration(raw: unknown) {
  const value = { catalog: structuredClone(raw) };
  const descriptive =
    isRecord(value.catalog) && Object.hasOwn(value.catalog, "descriptive_directory");
  exact(
    value.catalog,
    descriptive
      ? "descriptive_directory,public_source,publisher_scope,setup_plan_sha256"
      : "public_source,publisher_scope,setup_plan_sha256",
  );
  if (descriptive) {
    exact(value.catalog.descriptive_directory, "listing_delivery_schema,target");
    if (
      value.catalog.descriptive_directory.listing_delivery_schema !== 1 ||
      value.catalog.descriptive_directory.target !== "policy/official/catalog.listings.json"
    )
      throw new Error("catalog descriptive directory appointment differs");
  }
  const initialSite =
    isRecord(value.catalog.public_source) &&
    Object.hasOwn(value.catalog.public_source, "initial_site_preimage");
  exact(
    value.catalog.public_source,
    initialSite
      ? "commit,initial_site_preimage,offline_targets,root"
      : "commit,offline_targets,root",
  );
  const source = value.catalog.public_source;
  const root = catalogFilePin(source.root),
    targets = catalogFilePin(source.offline_targets);
  if (root.path === targets.path || root.sha256 === targets.sha256)
    throw new Error("catalog public anchors conflated");
  const preimage = initialSite ? catalogFilePin(source.initial_site_preimage) : undefined;
  if (
    preimage &&
    (preimage.bytes > 128 * 1024 ||
      [root.path, targets.path].includes(preimage.path) ||
      [root.sha256, targets.sha256].includes(preimage.sha256))
  )
    throw new Error("catalog initial site preimage differs from separate bounded setup pin");
  if (
    !Array.isArray(value.catalog.publisher_scope) ||
    (!descriptive && value.catalog.publisher_scope.length < 1) ||
    value.catalog.publisher_scope.length > 4096
  )
    throw new Error("catalog publisher scope unavailable");
  const seen = new Set<string>();
  const publisher_scope = value.catalog.publisher_scope.map((raw) => {
    exact(
      raw,
      "artifact_hosts,max_redirects,namespace,operations,policy_schemas,repository_id,stable_id,template",
    );
    const stable_id = scopeIdentity(raw.stable_id);
    if (raw.namespace !== "official" || seen.has(stable_id))
      throw new Error("catalog scope namespace/identity differs");
    seen.add(stable_id);
    const artifact_hosts = uniqueValues(raw.artifact_hosts, 32, (host) => {
      const name = text(host, 253);
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(name))
        throw new Error("catalog exact artifact hostname differs");
      return name;
    });
    const operations = uniqueValues(raw.operations, 4, (operation) => {
      if (!catalogOperations.includes(operation as (typeof catalogOperations)[number]))
        throw new Error("catalog operation scope differs");
      return operation as (typeof catalogOperations)[number];
    });
    const policy_schemas = uniqueValues(raw.policy_schemas, 4, (schema) => {
      if (typeof schema !== "number" || ![1, 2, 3, 4].includes(schema))
        throw new Error("catalog policy schema scope differs");
      return schema;
    });
    if (
      !policy_schemas.length ||
      typeof raw.max_redirects !== "number" ||
      !Number.isSafeInteger(raw.max_redirects) ||
      raw.max_redirects < 0 ||
      raw.max_redirects > 5
    )
      throw new Error("catalog scope redirects/schema differs");
    return {
      namespace: "official" as const,
      stable_id,
      template: scopeIdentity(raw.template),
      repository_id: raw.repository_id === null ? null : positive(raw.repository_id),
      artifact_hosts,
      max_redirects: raw.max_redirects,
      operations,
      policy_schemas,
    };
  });
  return {
    public_source: {
      commit: hex(source.commit, 40),
      root,
      offline_targets: targets,
      ...(preimage ? { initial_site_preimage: preimage } : {}),
    },
    setup_plan_sha256: hex(value.catalog.setup_plan_sha256, 64),
    publisher_scope,
    ...(descriptive
      ? {
          descriptive_directory: {
            listing_delivery_schema: 1 as const,
            target: "policy/official/catalog.listings.json" as const,
          },
        }
      : {}),
  };
}
/** Source/config binding only; imported policy or JSON never creates OIDC or
 * live protection/semantic acceptance. The getter in release-authority-configuration.mts adds identity. */
export function inspectBoundCatalogControllerAuthorities(
  raw: unknown,
  source: {
    mode: unknown;
    authority_configuration_sha256?: string;
    grant_sha256?: string;
    actor_id: string;
  },
) {
  if (
    source.mode !== "bounded-catalog-publication" ||
    !source.authority_configuration_sha256 ||
    !source.grant_sha256
  )
    throw new Error("explicit catalog controller grant required");
  hex(source.grant_sha256, 64);
  hex(source.authority_configuration_sha256, 64);
  const configuration = inspectCatalogAuthorityConfiguration(raw),
    configuration_sha256 = releaseCanonicalDigest(configuration);
  if (
    configuration_sha256 !== source.authority_configuration_sha256 ||
    configuration.apps.dispatch.actor_id !== source.actor_id
  )
    throw new Error("catalog authority configuration/dispatch changed after ratification");
  return { ...configuration, configuration_sha256 };
}
function inspectCatalogScopeAuthorities(raw: unknown) {
  if (isRecord(raw) && raw.schema_version === 4) {
    const selected = inspectSelectedPublicationAuthorityConfiguration(raw);
    if (selected.purpose !== "catalog-publication")
      throw new Error("catalog publisher requires catalog purpose");
    return selected;
  }
  return inspectCatalogAuthorityConfiguration(raw);
}
/** Limits an already Core-inspected bundle to the appointed publisher. This
 * assertion does not authenticate the supplied report or create acceptance. */
export function assertControllerCatalogPublisherScope(
  raw: unknown,
  inspection: unknown,
  files: ReadonlyMap<string, Buffer>,
) {
  const authorities = inspectCatalogScopeAuthorities(
    isRecord(raw) && Object.hasOwn(raw, "configuration_sha256")
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "configuration_sha256"))
      : raw,
  );
  if (
    isRecord(raw) &&
    Object.hasOwn(raw, "configuration_sha256") &&
    raw.configuration_sha256 !== releaseCanonicalDigest(authorities)
  )
    throw new Error("catalog publisher configuration digest differs");
  const report = inspectCatalogCoreReport(inspection, files);
  if (report.publication_schema === 2 && !authorities.catalog.descriptive_directory)
    throw new Error("descriptive directory is outside appointed publisher scope");
  for (const rawDefinition of report.definitions as unknown[]) {
    if (
      !isRecord(rawDefinition) ||
      rawDefinition.namespace !== "official" ||
      typeof rawDefinition.stable_id !== "string" ||
      typeof rawDefinition.policy_target !== "string" ||
      typeof rawDefinition.definition_target !== "string"
    )
      throw new Error("catalog Core identity absent");
    const scope = authorities.catalog.publisher_scope.find(
      (row) => row.stable_id === rawDefinition.stable_id,
    );
    const definitionBytes = files.get(rawDefinition.definition_target),
      policyBytes = files.get(rawDefinition.policy_target);
    if (!scope || !definitionBytes || !policyBytes)
      throw new Error("catalog title outside appointed publisher scope");
    const definition: unknown = JSON.parse(definitionBytes.toString("utf8")),
      policy: unknown = JSON.parse(policyBytes.toString("utf8"));
    if (
      !isRecord(definition) ||
      !isRecord(definition.port) ||
      definition.port.adapter !== scope.template ||
      !isRecord(policy) ||
      typeof policy.policy_schema !== "number" ||
      !scope.policy_schemas.includes(policy.policy_schema) ||
      policy.policy_schema !== rawDefinition.policy_schema ||
      !isRecord(policy.decision)
    )
      throw new Error("catalog template/schema outside appointed publisher scope");
    const decision = policy.decision;
    if (decision.status === "managed_github") {
      if (
        decision.template !== scope.template ||
        decision.repository_id !== scope.repository_id ||
        scope.repository_id === null ||
        !Array.isArray(decision.artifact_hosts) ||
        !decision.artifact_hosts.every(
          (host) => typeof host === "string" && scope.artifact_hosts.includes(host),
        ) ||
        !Array.isArray(decision.operations) ||
        !decision.operations.every((op) => scope.operations.includes(op as never)) ||
        typeof decision.max_redirects !== "number" ||
        !Number.isSafeInteger(decision.max_redirects) ||
        decision.max_redirects < 0 ||
        decision.max_redirects > scope.max_redirects
      )
        throw new Error("catalog managed Github capabilities exceed publisher scope");
    } else if (decision.status === "availability") {
      if (decision.template !== scope.template)
        throw new Error("catalog availability template exceeds publisher scope");
    } else if (decision.status !== "revoked") throw new Error("catalog Core policy status differs");
  }
  return { authority: "none" as const, scope: "appointed-catalog-publisher-limits-only" as const };
}
