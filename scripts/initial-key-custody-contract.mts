/** Initial backup appointments only. No Root, grant, publisher or production
 * configuration is installed by this public inventory. Payload credentials are
 * outside this explicitly named pre-payload snapshot, never silently omitted. */
import { createHash } from "node:crypto";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

export const initialCustodyTufRoles = [
  "application-root",
  "application-targets",
  "application-snapshot",
  "application-timestamp",
  "application-releases",
  "application-preview",
  "application-stable",
  "catalog-root",
  "catalog-targets",
  "catalog-snapshot",
  "catalog-timestamp",
  "catalog-official-definitions",
  "catalog-official-policy",
] as const;
const appRoles = ["semantic", "protection_observer"] as const;
function exact(value: unknown, fields: string): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== fields.split(",").sort().join(",")
  )
    throw new Error("initial custody public inventory fields differ");
}
function hex(value: unknown, length = 64): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error("initial custody public identity differs");
}
export function inspectInitialKeyCustodyInventory(bytes: Buffer, expectedSha256: string) {
  hex(expectedSha256);
  if (
    bytes.length < 1 ||
    bytes.length > 65536 ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  )
    throw new Error("initial custody inventory differs from independent pin");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  exact(
    value,
    "schema_version,kind,repository_id,source_commit,source_tree,creation_receipt_sha256,payload_credential,keys,apps",
  );
  if (
    value.schema_version !== 1 ||
    value.kind !== "initial-pre-payload-key-custody-v1" ||
    value.repository_id !== 1354613114 ||
    value.payload_credential !== "not-created-not-covered" ||
    !Array.isArray(value.keys) ||
    value.keys.length !== initialCustodyTufRoles.length
  )
    throw new Error("initial custody profile or complete pre-payload scope differs");
  hex(value.source_commit, 40);
  hex(value.source_tree, 40);
  hex(value.creation_receipt_sha256);
  const keys = value.keys.map((entry: unknown) => {
    exact(entry, "role,key_id,public_key");
    hex(entry.key_id);
    if (!initialCustodyTufRoles.some((role) => role === entry.role))
      throw new Error("initial custody role differs");
    exact(entry.public_key, "keytype,scheme,keyval");
    exact(entry.public_key.keyval, "public");
    hex(entry.public_key.keyval.public);
    if (
      entry.public_key.keytype !== "ed25519" ||
      entry.public_key.scheme !== "ed25519" ||
      releaseCanonicalDigest(entry.public_key) !== entry.key_id
    )
      throw new Error("initial custody canonical public key differs");
    return {
      role: String(entry.role),
      key_id: entry.key_id,
      kind: "tuf" as const,
      public_key: {
        keytype: "ed25519",
        scheme: "ed25519",
        keyval: { public: entry.public_key.keyval.public },
      },
    };
  });
  exact(value.apps, "semantic,protection_observer");
  const appRecords = value.apps;
  const apps = appRoles.map((role) => {
    const app = appRecords[role];
    exact(app, "app_id,installation_id,public_key_sha256");
    hex(app.public_key_sha256);
    for (const name of ["app_id", "installation_id"])
      if (
        typeof app[name] !== "number" ||
        !Number.isSafeInteger(app[name]) ||
        Number(app[name]) < 1
      )
        throw new Error("initial custody measured App identity differs");
    if (app.app_id === 15368) throw new Error("generic Actions issuer cannot appoint App custody");
    return {
      role: `github-app-${role}`,
      key_id: app.public_key_sha256,
      kind: "github-app" as const,
      public_key: { app_id: app.app_id, spki_sha256: app.public_key_sha256 },
      installation_id: app.installation_id,
    };
  });
  const bindings = [
    ...keys,
    ...apps.map((app) => ({
      role: app.role,
      key_id: app.key_id,
      kind: app.kind,
      public_key: app.public_key,
    })),
  ].sort((a, b) => a.role.localeCompare(b.role));
  if (
    new Set(bindings.map((b) => b.role)).size !== 15 ||
    new Set(bindings.map((b) => b.key_id)).size !== 15 ||
    new Set(keys.map((b) => b.public_key.keyval.public)).size !== 13 ||
    apps[0]!.public_key.app_id === apps[1]!.public_key.app_id ||
    apps[0]!.installation_id === apps[1]!.installation_id
  )
    throw new Error("initial custody role or public identities alias");
  return {
    bindings,
    inventory_sha256: expectedSha256,
    context_sha256: releaseCanonicalDigest({ kind: value.kind, inventory_sha256: expectedSha256 }),
  };
}
