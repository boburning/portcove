/** Fixed-source, secret-free tool production and attested tool consumption. */
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  applicationFileIdentity,
  readApplicationJson,
  receiveStagedApplicationToolData,
  writeApplicationJson,
} from "./application-release-io.mts";
import { inspectApplicationReleaseExecution } from "./application-release-policy.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import {
  readReleaseToolDependencies,
  verifyInstalledReleasePackage,
} from "./release-tool-dependencies.mts";
import { isRecord } from "./runtime-values.mts";

export const applicationToolFiles = [
  "tauri.js",
  "main.js",
  "index.js",
  "package.json",
  "cli.linux-x64-gnu.node",
  "portcove-release-tools",
  "application-release-private.bundle.mjs",
] as const;

async function requireApplicationToolNodeVersion() {
  const pin = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
  assert.equal(process.versions.node, pin, "application tools require the checked-out Node pin");
  return pin;
}

const checkout = fileURLToPath(new URL("../", import.meta.url));

function applicationToolSelection() {
  const { tauri, bundler, sigstoreSign } = readReleaseToolDependencies(checkout);
  const root = createRequire(new URL("../package.json", import.meta.url));
  verifyInstalledReleasePackage(
    root.resolve("vite-plus/package.json"),
    "vite-plus",
    bundler.slice("vite-plus@".length),
  );
  verifyInstalledReleasePackage(
    root.resolve("@sigstore/sign/package.json"),
    "@sigstore/sign",
    sigstoreSign,
  );
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const cliPackage = require.resolve("@tauri-apps/cli/package.json");
  verifyInstalledReleasePackage(cliPackage, "@tauri-apps/cli", tauri);
  const nativeName = "@tauri-apps/cli-linux-x64-gnu";
  const fromCli = createRequire(cliPackage);
  verifyInstalledReleasePackage(fromCli.resolve(nativeName + "/package.json"), nativeName, tauri);
  return { tauri, cli: path.dirname(cliPackage), native: fromCli.resolve(nativeName) };
}

export async function stageApplicationTools(
  execution: ReturnType<typeof inspectApplicationReleaseExecution>,
  output: string,
  releaseTools: string,
) {
  const node = await requireApplicationToolNodeVersion();
  const { tauri, cli, native } = applicationToolSelection();
  await mkdir(output);
  for (const name of ["tauri.js", "main.js", "index.js", "package.json"])
    await copyFile(path.join(cli, name), path.join(output, name));
  await copyFile(native, path.join(output, "cli.linux-x64-gnu.node"));
  await copyFile(releaseTools, path.join(output, "portcove-release-tools"));
  const { bundleApplicationReleasePrivate } = await import("./release-controller-tool-build.mts");
  await bundleApplicationReleasePrivate(checkout, output);
  await copyFile(
    path.join(output, "scripts/application-release-private.bundle.mjs"),
    path.join(output, "application-release-private.bundle.mjs"),
  );
  await rm(path.join(output, "scripts"), { recursive: true });
  const files = await Promise.all(
    applicationToolFiles.map((name) => applicationFileIdentity(path.join(output, name))),
  );
  await writeApplicationJson(path.join(output, "tools.json"), {
    schema_version: 1,
    ...execution,
    node,
    tauri_cli: tauri,
    files,
  });
}

async function receiveApplicationTools(id: number, attempt: number) {
  const execution = inspectApplicationReleaseExecution(process.env);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= execution.run_attempt);
  const directory = path.resolve("work/application-tools");
  const parent = process.env.RUNNER_TEMP;
  assert.ok(parent && path.isAbsolute(parent));
  const scratch = path.join(parent, "portcove-native-attester-tools");
  let files: Awaited<ReturnType<typeof receiveApplicationToolArchive>>;
  try {
    files = await receiveApplicationToolArchive(
      directory,
      { ...execution, run_attempt: attempt },
      id,
      scratch,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const subject = await applicationFileIdentity(path.join(directory, "tools.json"));
  await verifyReleaseSourceAttestation(directory, "tools.json", {
    source_commit: execution.source,
    ref: execution.ref,
    run_id: execution.run_id,
    run_attempt: attempt,
    subjects: [...files, subject],
  });
  await chmod(path.join(directory, "portcove-release-tools"), 0o700);
  // The worker runs beside the fixed checkout's reviewed public assets.
  await copyFile(
    path.join(directory, "application-release-private.bundle.mjs"),
    "scripts/application-release-private.bundle.mjs",
    1,
  );
  return directory;
}

/** Verify the exact provider ZIP and its staged tools before production attestation. */
export async function receiveApplicationToolArchive(
  directory: string,
  execution: ReturnType<typeof inspectApplicationReleaseExecution>,
  id: number,
  scratch: string,
) {
  const expected = {
    id,
    name: `application-tools-${execution.run_id}-${execution.run_attempt}`,
    run_id: execution.run_id,
    source: execution.source,
    files: [...applicationToolFiles, "tools.json"],
    maximum_file_bytes: 128 * 1024 ** 2,
    maximum_archive_bytes: 320 * 1024 ** 2,
  };
  await receiveStagedApplicationToolData(directory, expected, scratch);
  return verifyStagedApplicationTools(directory, execution);
}

async function verifyStagedApplicationTools(
  directory: string,
  execution: ReturnType<typeof inspectApplicationReleaseExecution>,
) {
  const node = await requireApplicationToolNodeVersion();
  const { tauri } = readReleaseToolDependencies(checkout);
  const manifest = await readApplicationJson(path.join(directory, "tools.json"), 65536);
  assert.ok(isRecord(manifest));
  assert.deepEqual(
    {
      source: manifest.source,
      ref: manifest.ref,
      run_id: manifest.run_id,
      run_attempt: manifest.run_attempt,
    },
    execution,
  );
  assert.equal(manifest.node, node);
  assert.equal(manifest.tauri_cli, tauri);
  verifyInstalledReleasePackage(path.join(directory, "package.json"), "@tauri-apps/cli", tauri);
  const files = await Promise.all(
    applicationToolFiles.map((name) => applicationFileIdentity(path.join(directory, name))),
  );
  assert.deepEqual(manifest.files, files);
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "check") {
    await requireApplicationToolNodeVersion();
    applicationToolSelection();
  } else if (process.argv[2] === "build")
    await stageApplicationTools(
      inspectApplicationReleaseExecution(process.env),
      path.resolve("work/application-tools"),
      "target/release/portcove-release-tools",
    );
  else if (process.argv[2] === "receive-file")
    await receiveApplicationTools(
      Number(process.env.PORTCOVE_TOOLS_ARTIFACT),
      Number(process.env.PORTCOVE_TOOLS_ATTEMPT),
    );
  else throw new Error("unknown fixed application tool operation");
}
