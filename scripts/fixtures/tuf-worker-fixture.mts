/** Disposable offline preparation for the actual Rust worker test. No private
 * key is written by this producer; only the individual worker sees its own DER.
 * These public files and keys establish no production setup or role authority. */
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../runtime-values.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, canonical(value[name])]),
    );
  return value;
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(canonical(value)));
function key() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const publicValue = { keytype: "ed25519", scheme: "ed25519", keyval: { public: publicKey } };
  return { id: hash(bytes(publicValue)), public: publicValue, private: pair.privateKey };
}
type TestKey = ReturnType<typeof key>;
function envelope(signed: object, keys: readonly TestKey[]) {
  return bytes({
    signed,
    signatures: keys.map((entry) => ({
      keyid: entry.id,
      sig: sign(null, bytes(signed), entry.private).toString("hex"),
    })),
  });
}
export async function disposableTufWorkerFixture(root: string) {
  await mkdir(root, { mode: 0o700 });
  const roots = [key(), key(), key()],
    names = ["targets", "snapshot", "timestamp", "releases", "preview", "stable"] as const;
  const online = Object.fromEntries(names.map((name) => [name, key()])) as Record<
    (typeof names)[number],
    TestKey
  >;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const at = (days: number) =>
    new Date(Date.parse(now) + days * 86400000).toISOString().replace(".000Z", "Z");
  const expires = {
    targets: at(90),
    snapshot: at(7),
    timestamp: at(1),
    releases: at(90),
    preview: at(7),
    stable: at(7),
  };
  const topNames = ["targets", "snapshot", "timestamp"] as const;
  const rootBytes = envelope(
    {
      _type: "root",
      spec_version: "1.0.0",
      consistent_snapshot: true,
      version: 1,
      expires: at(365),
      keys: Object.fromEntries(
        [...roots, ...topNames.map((name) => online[name])].map((entry) => [
          entry.id,
          entry.public,
        ]),
      ),
      roles: {
        root: { keyids: roots.map((entry) => entry.id), threshold: 2 },
        ...Object.fromEntries(
          topNames.map((name) => [name, { keyids: [online[name].id], threshold: 1 }]),
        ),
      },
    },
    roots.slice(0, 2),
  );
  // Existing public-only disposable Minisign key. It has no private counterpart
  // in this fixture and no payload is manufactured or signed here.
  const payloadPublic = Buffer.from(
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo=",
    "base64",
  );
  const payload = bytes({
    schema_version: 1,
    keys: [{ id: hash(payloadPublic), tauri_public_key: payloadPublic.toString("base64") }],
  });
  const delegated = ["releases", "preview", "stable"] as const;
  const paths = (name: (typeof delegated)[number]) =>
    name === "releases"
      ? ["releases/*/windows-x86_64/nsis.json", "releases/*/linux-x86_64/appimage.json"]
      : [
          `channels/${name}/windows-x86_64/nsis/*.json`,
          `channels/${name}/linux-x86_64/appimage/*.json`,
        ];
  const top = envelope(
    {
      _type: "targets",
      spec_version: "1.0.0",
      version: 1,
      expires: expires.targets,
      targets: {
        "keys/payload.json": { length: payload.length, hashes: { sha256: hash(payload) } },
      },
      delegations: {
        keys: Object.fromEntries(delegated.map((name) => [online[name].id, online[name].public])),
        roles: delegated.map((name) => ({
          name,
          keyids: [online[name].id],
          threshold: 1,
          paths: paths(name),
          terminating: true,
        })),
      },
    },
    [online.targets],
  );
  const versions = Object.fromEntries(names.map((name) => [name, 1]));
  const context = {
    schema_version: 1,
    generated_at: now,
    trusted_root: "trusted-root.json",
    offline_targets: "offline-targets.json",
    payload_key_registry: "payload.json",
    reconstructed_records: "records",
    initial_bootstrap: "initial-bootstrap.json",
    versions,
    expires,
  };
  const descriptor = {
    schema_version: 1,
    kind: "application-tuf-initial-bootstrap",
    generated_at: now,
    setup_plan_sha256: "1".repeat(64),
    initial_site_preimage_sha256: "2".repeat(64),
    root_sha256: hash(rootBytes),
    offline_targets_sha256: hash(top),
    payload_key_registry_sha256: hash(payload),
    initial_records_sha256: hash(Buffer.from("[]")),
    versions: Object.fromEntries(names.map((name) => [name, "1"])),
    expires,
  };
  await mkdir(path.join(root, "records"), { mode: 0o700 });
  for (const [name, value] of new Map([
    ["context.json", bytes(context)],
    ["trusted-root.json", rootBytes],
    ["offline-targets.json", top],
    ["payload.json", payload],
    ["initial-bootstrap.json", bytes(descriptor)],
    ["records/reconstruction-manifest.json", bytes({ schema_version: 1, records: [] })],
  ]))
    await writeFile(path.join(root, name), value, { flag: "wx", mode: 0o600 });
  // Keep only the five online keys; root and offline-target keys are neither
  // exported nor written, and never enter a worker's process environment.
  return Object.fromEntries(
    ["releases", "preview", "stable", "snapshot", "timestamp"].map((name) => [
      name,
      online[name as keyof typeof online].private.export({ format: "der", type: "pkcs8" }),
    ]),
  ) as Record<"releases" | "preview" | "stable" | "snapshot" | "timestamp", Buffer>;
}
