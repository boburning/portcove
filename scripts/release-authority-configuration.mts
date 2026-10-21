import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import {
  nativePrepublicationProfile,
  inspectNativeQualificationHarnessPath,
} from "./release-native-qualification-contract.mts";
import {
  admitProductionInputReader,
  admitProductionClassificationWriter,
  admitProductionClassificationObserver,
  readProductionControllerWorkflowBytes,
  admitReviewedInputsWriter,
  readReviewedInputsWorkflowBytes,
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
export function inspectPublicationAuthorities(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(value, "initial_site_preimage_sha256,public_source,setup_plan_sha256");
  exact(value.public_source, "commit,offline_targets,payload_key_registry,root");
  const source = value.public_source;
  const files = Object.fromEntries(
    (["root", "offline_targets", "payload_key_registry"] as const).map((name) => {
      const file = source[name];
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
      return [name, { path: file.path, bytes: Number(file.bytes), sha256: hex(file.sha256, 64) }];
    }),
  ) as Record<
    "root" | "offline_targets" | "payload_key_registry",
    { path: string; bytes: number; sha256: string }
  >;
  if (new Set(Object.values(files).map((file) => file.path)).size !== 3)
    throw new Error("publication public data paths are conflated");
  return {
    public_source: { commit: hex(source.commit, 40), ...files },
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
    apps,
    native,
    ...(value.publication === undefined
      ? {}
      : { publication: inspectPublicationAuthorities(value.publication) }),
  };
}
export type ReleaseAuthorityConfiguration = ReturnType<typeof inspectReleaseAuthorityConfiguration>;

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
/** Configuration projection only. The hosted factory above additionally binds
 * its digest to the actual protected controller source and ratified grant. */
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

function inspectBoundControllerAuthorities(
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
