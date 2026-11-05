/** Compile the already appointed public bytes without publishing a new bundle. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import {
  applicationReleaseTrust,
  inspectApplicationPackageExecution,
  verifyApplicationReleaseTrust,
} from "./application-release-policy.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function prepareApplicationBuildInputs(directory: string, control: string) {
  assert.match(control, /^[a-f0-9]{40}$/u);
  await verifyApplicationReleaseTrust();
  const registry: unknown = JSON.parse(
    await readFile(path.join(project, applicationReleaseTrust.payload.path), "utf8"),
  );
  assert.ok(
    isRecord(registry) &&
      Array.isArray(registry.keys) &&
      registry.keys.length === 1 &&
      isRecord(registry.keys[0]),
  );
  const key = registry.keys[0].tauri_public_key;
  assert.ok(typeof key === "string");
  const publicKey = Buffer.from(key);
  const payloadHash = hash(publicKey);
  assert.equal(payloadHash, "f24b27f315a1682698a91997dd3a5cc62cf2850454167866b830c8bb7e640d44");
  const packaging = await readFile(
    path.join(project, "apps/desktop/src-tauri/tauri.release-public.conf.json"),
  );
  const packagingHash = hash(packaging);
  assert.equal(packagingHash, "96a88182f65fe5ca713adf240b84f1c12aa44e639565a5bd2e9a09b3d5c94ae7");
  const configuration = JSON.parse(packaging.toString("utf8")) as {
    plugins: { updater: { pubkey: string } };
  };
  configuration.plugins.updater.pubkey = key;
  const configurationBytes = Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`);
  assert.equal(
    hash(configurationBytes),
    "285912b604b05815a1f8932651926b756b16d92005384766e5c19fcc028013f0",
  );
  await mkdir(directory, { recursive: false });
  const config = path.join(directory, "tauri.release-public.conf.json");
  const receiptFile = path.join(directory, "build-inputs.json");
  const receipt = {
    schema_version: 3,
    authority: "none",
    control_commit: control,
    initial_root_profile: "single-owner-one-of-one-v1",
    root_sha256: applicationReleaseTrust.root.sha256,
    payload_public_key_sha256: payloadHash,
    packaging_sha256: packagingHash,
    tauri_configuration_sha256: hash(configurationBytes),
    metadata_url: applicationReleaseTrust.metadata,
    targets_url: applicationReleaseTrust.content,
    signing: "deferred; secret-free --no-sign build",
  };
  await writeFile(config, configurationBytes, { flag: "wx" });
  await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
  return {
    receipt,
    environment: {
      PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE: path.join(
        project,
        applicationReleaseTrust.root.path,
      ),
      PORTCOVE_APPLICATION_UPDATE_METADATA_URL: applicationReleaseTrust.metadata,
      PORTCOVE_APPLICATION_UPDATE_TARGETS_URL: applicationReleaseTrust.content,
      PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION: config,
      PORTCOVE_RELEASE_PUBLIC_BUILD_RECEIPT: receiptFile,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const execution = inspectApplicationPackageExecution(process.env);
  assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV);
  const prepared = await prepareApplicationBuildInputs(
    path.join(process.env.RUNNER_TEMP, "application-public-build"),
    execution.source,
  );
  for (const [name, value] of Object.entries(prepared.environment)) {
    assert.ok(!/[\r\n\0]/u.test(value));
    await appendFile(process.env.GITHUB_ENV, `${name}=${value}\n`);
  }
}
