/** Explicit initial or complete backup appointments. No Root, grant, publisher
 * or production configuration is installed by this public inventory. Historical
 * pre-payload snapshots retain their original scope and authenticated context. */
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
  return inspectInventory(bytes, expectedSha256, false);
}
/** Complete release custody is explicitly selected; the historical initial
 * snapshot cannot acquire payload coverage merely by changing a label. */
export function inspectCompleteKeyCustodyInventory(bytes: Buffer, expectedSha256: string) {
  return inspectInventory(bytes, expectedSha256, true);
}
function inspectInventory(bytes: Buffer, expectedSha256: string, complete: boolean) {
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
    "schema_version,kind,repository_id,source_commit,source_tree,creation_receipt_sha256,payload_credential,keys,apps" +
      (complete ? ",payload" : ""),
  );
  if (
    value.schema_version !== 1 ||
    value.kind !==
      (complete ? "complete-release-key-custody-v1" : "initial-pre-payload-key-custody-v1") ||
    value.repository_id !== 1354613114 ||
    value.payload_credential !== (complete ? "covered" : "not-created-not-covered") ||
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
  const payload = [];
  if (complete) {
    exact(value.payload, "profile,public_key_base64,public_key_sha256,ed25519_public_key");
    hex(value.payload.public_key_sha256);
    hex(value.payload.ed25519_public_key);
    const payloadPublic = value.payload.ed25519_public_key;
    if (
      value.payload.profile !== "tauri-minisign-empty-password-v1" ||
      typeof value.payload.public_key_base64 !== "string" ||
      !value.payload.public_key_base64.length ||
      value.payload.public_key_base64.length > 4096 ||
      Buffer.from(value.payload.public_key_base64, "base64").toString("base64") !==
        value.payload.public_key_base64 ||
      createHash("sha256").update(value.payload.public_key_base64).digest("hex") !==
        value.payload.public_key_sha256 ||
      keys.some((key) => key.public_key.keyval.public === payloadPublic)
    )
      throw new Error("complete custody payload public identity differs");
    // Structural public-box validation only; private correspondence remains
    // the maintained Minisign inspector's job. Tauri's public wire is Ed,
    // an eight-byte key number, then the 32-byte Ed25519 public key.
    const decoded = Buffer.from(value.payload.public_key_base64, "base64");
    const text = decoded.toString("utf8");
    const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    const raw = Buffer.from(lines[1] ?? "", "base64");
    if (
      !Buffer.from(text).equals(decoded) ||
      lines.length !== 2 ||
      !lines[0]!.startsWith("untrusted comment: ") ||
      lines[0]!.length > 256 ||
      lines[0]!.includes("\r") ||
      raw.toString("base64") !== lines[1] ||
      raw.length !== 42 ||
      raw.subarray(0, 2).toString("ascii") !== "Ed" ||
      raw.subarray(10).toString("hex") !== value.payload.ed25519_public_key
    )
      throw new Error("complete custody payload public encoding differs");
    payload.push({
      role: "application-payload",
      key_id: value.payload.public_key_sha256,
      kind: "payload" as const,
      public_key: {
        profile: value.payload.profile,
        base64: value.payload.public_key_base64,
        ed25519_public_key: value.payload.ed25519_public_key,
      },
    });
  }
  const bindings = [
    ...keys,
    ...payload,
    ...apps.map((app) => ({
      role: app.role,
      key_id: app.key_id,
      kind: app.kind,
      public_key: app.public_key,
    })),
  ].sort((a, b) => a.role.localeCompare(b.role));
  if (
    new Set(bindings.map((b) => b.role)).size !== (complete ? 16 : 15) ||
    new Set(bindings.map((b) => b.key_id)).size !== (complete ? 16 : 15) ||
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
