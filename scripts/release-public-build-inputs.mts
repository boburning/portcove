import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const files = ["bundle.json", "root.json", "updater-public.key", "packaging.json"].sort();
const metadataUrl = "https://boburning.github.io/portcove/application/metadata/";
const targetsUrl = "https://boburning.github.io/portcove/application/targets/";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function exact(
  value: unknown,
  keys: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys.sort().join(","))
    throw new Error(`invalid public ${label} fields`);
}

/** Public bytes are authorized only by the separately ratified immutable commit
 * and manifest digest. Parsing or copying them creates no new publisher authority.
 * TUF signature/expiry validation remains owned by the maintained runtime. */
export function inspectPublicBuildInputIdentity(revision: unknown, digest: unknown) {
  if (
    typeof revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    throw new Error("ratified public configuration commit and manifest SHA-256 are required");
  return { revision, digest };
}

export async function readBoundedPublicBuildInputFile(
  root: string,
  filename: string,
  maximum: number,
) {
  const absolute = await assertOwnedUnlinkedPath(root, path.join(root, filename), "public input");
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum)
    throw new Error("public input must be a bounded nonempty regular file");
  const handle = await open(absolute, "r");
  try {
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const read = await handle.read(bytes, length, maximum + 1 - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length < 1 || length > maximum) throw new Error("public input exceeded its byte bound");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
const boundedFile = readBoundedPublicBuildInputFile;

function inspectRoot(bytes: Buffer) {
  const root: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(root) ||
    !isRecord(root.signed) ||
    !Array.isArray(root.signatures) ||
    !root.signatures.length ||
    root.signed._type !== "root" ||
    !Number.isSafeInteger(root.signed.version) ||
    Number(root.signed.version) < 1 ||
    root.signed.consistent_snapshot !== true ||
    !isRecord(root.signed.roles) ||
    !isRecord(root.signed.keys) ||
    !Object.keys(root.signed.keys).length ||
    typeof root.signed.expires !== "string" ||
    !Number.isFinite(Date.parse(root.signed.expires))
  )
    throw new Error("public application root is not a signed TUF root envelope");
  exact(root, ["signed", "signatures"], "root envelope");
  exact(
    root.signed,
    ["_type", "spec_version", "version", "consistent_snapshot", "expires", "keys", "roles"],
    "root",
  );
  const keys = root.signed.keys;
  for (const name of ["root", "targets", "snapshot", "timestamp"]) {
    const role = root.signed.roles[name];
    if (
      !isRecord(role) ||
      !Array.isArray(role.keyids) ||
      !role.keyids.length ||
      !Number.isSafeInteger(role.threshold) ||
      Number(role.threshold) < 1 ||
      Number(role.threshold) > role.keyids.length ||
      role.keyids.some((id) => typeof id !== "string" || !Object.hasOwn(keys, id))
    )
      throw new Error("public application root lacks a required role");
  }
  for (const key of Object.values(root.signed.keys)) {
    if (
      !isRecord(key) ||
      !isRecord(key.keyval) ||
      Object.keys(key.keyval).join(",") !== "public" ||
      typeof key.keyval.public !== "string"
    )
      throw new Error("application root may contain public verification keys only");
  }
}

function inspectPayloadKey(bytes: Buffer) {
  const key = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) throw new Error("invalid Tauri public key encoding");
  const decoded = Buffer.from(key, "base64");
  if (decoded.toString("base64") !== key) throw new Error("noncanonical Tauri public key");
  const lines = decoded.toString("utf8").trimEnd().split(/\r?\n/u);
  const encoded = lines[1];
  if (
    lines.length !== 2 ||
    !lines[0]?.startsWith("untrusted comment: ") ||
    !encoded ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  )
    throw new Error("invalid Minisign public key");
  const raw = Buffer.from(encoded, "base64");
  if (
    raw.length !== 42 ||
    raw.subarray(0, 2).toString("ascii") !== "Ed" ||
    raw.toString("base64") !== encoded
  )
    throw new Error("invalid Minisign public verification key");
  return key;
}

export async function prepareReleasePublicBuildInputs(options: {
  configurationRoot: string;
  observedRevision: string;
  expectedRevision: string;
  expectedManifestSha256: string;
  outputRoot: string;
  projectRoot?: string;
}) {
  const expected = inspectPublicBuildInputIdentity(
    options.expectedRevision,
    options.expectedManifestSha256,
  );
  if (options.observedRevision !== expected.revision)
    throw new Error("public configuration checkout changed");
  const configurationRoot = path.resolve(options.configurationRoot);
  const configurationDirectory = await lstat(configurationRoot);
  if (!configurationDirectory.isDirectory() || configurationDirectory.isSymbolicLink())
    throw new Error("public configuration bundle must be a direct directory");
  // No scripts/actions from this checkout are ever executed. Refuse extra material,
  // including accidental private keys, before creating build outputs.
  if (JSON.stringify((await readdir(configurationRoot)).sort()) !== JSON.stringify(files))
    throw new Error("public input bundle must contain exactly the four declared files");
  const manifestBytes = await boundedFile(configurationRoot, "bundle.json", 16 * 1024);
  if (sha256(manifestBytes) !== expected.digest)
    throw new Error("public input manifest digest differs");
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  exact(
    manifest,
    [
      "schema_version",
      "repository",
      "purpose",
      "metadata_url",
      "targets_url",
      "root",
      "payload_public_key",
      "packaging",
    ],
    "manifest",
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.repository !== "boburning/portcove" ||
    manifest.purpose !== "application-release-public-build-inputs" ||
    manifest.metadata_url !== metadataUrl ||
    manifest.targets_url !== targetsUrl
  )
    throw new Error("public input scope or application origins differ");
  const read = async (field: string, filename: string, maximum: number) => {
    const identity = manifest[field];
    exact(identity, ["bytes", "sha256"], field);
    const bytes = await boundedFile(configurationRoot, filename, maximum);
    if (identity.bytes !== bytes.length || identity.sha256 !== sha256(bytes))
      throw new Error(`public ${field} bytes differ from the ratified manifest`);
    return bytes;
  };
  const root = await read("root", "root.json", 256 * 1024);
  const payloadKey = await read("payload_public_key", "updater-public.key", 16 * 1024);
  const packaging = await read("packaging", "packaging.json", 16 * 1024);
  inspectRoot(root);
  const publicKey = inspectPayloadKey(payloadKey);
  const template = await boundedFile(
    path.join(options.projectRoot ?? project, "apps/desktop/src-tauri"),
    "tauri.release-public.conf.json",
    16 * 1024,
  );
  const overlay: unknown = JSON.parse(packaging.toString("utf8"));
  if (!isDeepStrictEqual(overlay, JSON.parse(template.toString("utf8"))))
    throw new Error("public packaging configuration differs from the fixed updater-only overlay");
  // The overlay is exact, so no arbitrary build hooks, endpoints, resources or
  // executable inputs can enter through the public configuration transport.
  const config = JSON.parse(packaging.toString("utf8")) as {
    plugins: { updater: { pubkey?: string } };
  };
  config.plugins.updater.pubkey = publicKey;
  const outputRoot = path.resolve(options.outputRoot);
  if (/[\r\n\0]/u.test(outputRoot)) throw new Error("invalid public build output path");
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(path.join(outputRoot, "release-public-inputs-"));
  const rootFile = path.join(output, "root.json");
  const configuration = path.join(output, "tauri.release-public.conf.json");
  const configurationBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  const receipt = {
    schema_version: 1,
    authority: "none",
    configuration_revision: expected.revision,
    manifest_sha256: expected.digest,
    root_sha256: sha256(root),
    payload_public_key_sha256: sha256(payloadKey),
    packaging_sha256: sha256(packaging),
    tauri_configuration_sha256: sha256(configurationBytes),
    metadata_url: metadataUrl,
    targets_url: targetsUrl,
    signing: "deferred; secret-free --no-sign build",
  };
  await writeFile(rootFile, root, { flag: "wx" });
  await writeFile(configuration, configurationBytes, { flag: "wx" });
  await writeFile(path.join(output, "updater-public.key"), payloadKey, { flag: "wx" });
  await writeFile(path.join(output, "bundle.json"), manifestBytes, { flag: "wx" });
  await writeFile(path.join(output, "packaging.json"), packaging, { flag: "wx" });
  const receiptFile = path.join(output, "build-inputs.json");
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return {
    output,
    receipt,
    environment: {
      PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE: rootFile,
      PORTCOVE_APPLICATION_UPDATE_METADATA_URL: metadataUrl,
      PORTCOVE_APPLICATION_UPDATE_TARGETS_URL: targetsUrl,
      PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION: configuration,
      PORTCOVE_RELEASE_PUBLIC_BUILD_RECEIPT: receiptFile,
      PORTCOVE_RELEASE_PUBLIC_BUILD_INPUT_DIRECTORY: output,
    },
  };
}

async function main() {
  const expected = inspectPublicBuildInputIdentity(
    process.env.PORTCOVE_APPLICATION_PUBLIC_INPUTS_REVISION,
    process.env.PORTCOVE_APPLICATION_PUBLIC_INPUTS_SHA256,
  );
  if (process.argv.slice(2).join(" ") === "--validate-identity") {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT unavailable");
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `revision=${expected.revision}\nmanifest_sha256=${expected.digest}\n`,
    );
    return;
  }
  if (process.argv.length !== 2)
    throw new Error("public build inputs accept no candidate arguments");
  for (const name of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"])
    if (process.env[name]) throw new Error("public packaging must not receive signing credentials");
  const checkout = process.env.PORTCOVE_PUBLIC_CONFIGURATION_CHECKOUT;
  const outputRoot = process.env.RUNNER_TEMP;
  const githubEnvironment = process.env.GITHUB_ENV;
  if (!checkout || !outputRoot || !githubEnvironment)
    throw new Error("public build input paths unavailable");
  const observedRevision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const result = await prepareReleasePublicBuildInputs({
    configurationRoot: path.join(checkout, "release-public-inputs"),
    observedRevision,
    expectedRevision: expected.revision,
    expectedManifestSha256: expected.digest,
    outputRoot,
  });
  await appendFile(
    githubEnvironment,
    Object.entries(result.environment)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  console.log(JSON.stringify(result.receipt));
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
