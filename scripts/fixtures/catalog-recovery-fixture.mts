/** Complete disposable catalog-only appointment. No application/payload Root,
 * production capture, private custody or publication claim. */
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { disposableTufEnvelope, disposableTufKey } from "./tuf-worker-fixture.mts";
import { selectedPublicationAuthoritiesFixture } from "./checkpoint-proof-fixture.mts";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export async function disposableCatalogRecoveryFixture(directory: string) {
  await mkdir(directory, { mode: 0o700 });
  const roles = [
    "root",
    "targets",
    "snapshot",
    "timestamp",
    "official-definitions",
    "official-policy",
  ];
  const keys = Object.fromEntries(roles.map((role) => [role, disposableTufKey()]));
  const expires = "2030-01-01T00:00:00Z"; // Recovery projection deliberately does not grant freshness.
  const root = disposableTufEnvelope(
    {
      _type: "root",
      spec_version: "1.0.0",
      consistent_snapshot: true,
      version: 1,
      expires,
      keys: Object.fromEntries(
        roles.slice(0, 4).map((role) => [keys[role]!.id, keys[role]!.public]),
      ),
      roles: Object.fromEntries(
        roles.slice(0, 4).map((role) => [role, { keyids: [keys[role]!.id], threshold: 1 }]),
      ),
    },
    [keys.root!],
  );
  const top = disposableTufEnvelope(
    {
      _type: "targets",
      spec_version: "1.0.0",
      version: 1,
      expires,
      targets: {},
      delegations: {
        keys: Object.fromEntries(
          roles.slice(4).map((role) => [keys[role]!.id, keys[role]!.public]),
        ),
        roles: roles.slice(4).map((role) => ({
          name: role,
          keyids: [keys[role]!.id],
          threshold: 1,
          terminating: true,
          paths:
            role === "official-definitions"
              ? ["definitions/index.json", "sha256/*.json"]
              : ["policy/official/*.json"],
        })),
      },
    },
    [keys.targets!],
  );
  await writeFile(path.join(directory, "root.json"), root, { mode: 0o600 });
  await writeFile(path.join(directory, "targets.json"), top, { mode: 0o600 });
  const config = selectedPublicationAuthoritiesFixture("catalog-publication");
  if (config.purpose !== "catalog-publication") throw new Error("fixture catalog purpose");
  config.catalog.public_source.root = {
    path: "public/catalog-root.json",
    bytes: root.length,
    sha256: hash(root),
  };
  config.catalog.public_source.offline_targets = {
    path: "public/catalog-targets.json",
    bytes: top.length,
    sha256: hash(top),
  };
  const inventoryConfig = path.join(directory, "inventory.json");
  await writeFile(
    inventoryConfig,
    JSON.stringify({
      schema_version: 1,
      initial_root_profile: "single-owner-one-of-one-v1",
      trusted_root: "root.json",
      trusted_root_sha256: hash(root),
      offline_targets: "targets.json",
      offline_targets_sha256: hash(top),
    }),
    { mode: 0o600 },
  );
  const material = new Map<string, Buffer>(
    roles.map((role) => [
      `catalog-${role}`,
      Buffer.from(keys[role]!.private.export({ format: "der", type: "pkcs8" })),
    ]),
  );
  const captures: Record<string, { app_id: number; public_key_sha256: string }> = {};
  for (const [role, app_id] of [
    ["semantic", 101],
    ["protection_observer", 202],
  ] as const) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    captures[role] = {
      app_id,
      public_key_sha256: hash(
        createPublicKey(pair.privateKey).export({ format: "der", type: "spki" }),
      ),
    };
    material.set(
      `github-app-${role}`,
      Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })),
    );
  }
  const inventory = {
    schema_version: 1,
    operation: "inspect-catalog-key-inventory",
    initial_root_profile: "single-owner-one-of-one-v1",
    root_sha256: hash(root),
    targets_sha256: hash(top),
    root_version: "1",
    targets_version: "1",
    keys: roles.map((role) => ({
      role: `catalog-${role}`,
      key_id: keys[role]!.id,
      public_key: keys[role]!.public,
    })),
    freshness: "not-evaluated-historical-key-bindings-only",
    authority: "none",
  };
  return { config, inventoryConfig, material, captures, inventory };
}
