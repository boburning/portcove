/** Fixed-source, secret-free tool production and attested tool consumption. */
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  applicationFileIdentity,
  readApplicationJson,
  receiveApplicationData,
  writeApplicationJson,
} from "./application-release-io.mts";
import { inspectApplicationReleaseExecution } from "./application-release-policy.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
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

async function build() {
  const execution = inspectApplicationReleaseExecution(process.env);
  assert.equal(process.versions.node, "24.22.2");
  const output = path.resolve("work/application-tools");
  await mkdir(output);
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const cliPackage = require.resolve("@tauri-apps/cli/package.json");
  const metadata: unknown = JSON.parse(await readFile(cliPackage, "utf8"));
  assert.ok(isRecord(metadata) && metadata.version === "2.12.2");
  const cli = path.dirname(cliPackage);
  for (const name of ["tauri.js", "main.js", "index.js", "package.json"])
    await copyFile(path.join(cli, name), path.join(output, name));
  const fromCli = createRequire(cliPackage);
  const native = fromCli.resolve("@tauri-apps/cli-linux-x64-gnu");
  await copyFile(native, path.join(output, "cli.linux-x64-gnu.node"));
  await copyFile(
    "target/release/portcove-release-tools",
    path.join(output, "portcove-release-tools"),
  );
  const { bundleApplicationReleasePrivate } = await import("./release-controller-tool-build.mts");
  await bundleApplicationReleasePrivate(process.cwd(), output);
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
    node: "24.22.2",
    tauri_cli: "2.12.2",
    files,
  });
}

export async function receiveApplicationTools(id: number, attempt: number) {
  const execution = inspectApplicationReleaseExecution(process.env);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= execution.run_attempt);
  const directory = path.resolve("work/application-tools");
  await receiveApplicationData(directory, {
    id,
    name: `application-tools-${execution.run_id}-${attempt}`,
    run_id: execution.run_id,
    source: execution.source,
    files: [...applicationToolFiles, "tools.json"],
    maximum_file_bytes: 128 * 1024 ** 2,
    maximum_archive_bytes: 320 * 1024 ** 2,
  });
  const manifest = await readApplicationJson(path.join(directory, "tools.json"), 65536);
  assert.ok(isRecord(manifest));
  assert.deepEqual(
    {
      source: manifest.source,
      ref: manifest.ref,
      run_id: manifest.run_id,
      run_attempt: manifest.run_attempt,
    },
    { ...execution, run_attempt: attempt },
  );
  assert.equal(manifest.node, "24.22.2");
  assert.equal(manifest.tauri_cli, "2.12.2");
  assert.equal(process.versions.node, manifest.node);
  const files = await Promise.all(
    applicationToolFiles.map((name) => applicationFileIdentity(path.join(directory, name))),
  );
  assert.deepEqual(manifest.files, files);
  const subject = await applicationFileIdentity(path.join(directory, "tools.json"));
  await verifyReleaseSourceAttestation(directory, "tools.json", {
    source_commit: execution.source,
    ref: execution.ref,
    run_id: execution.run_id,
    run_attempt: attempt,
    subjects: [...files, subject],
  });
  await chmod(path.join(directory, "portcove-release-tools"), 0o700);
  // The maintained bundler's fixed module-location adapter expects a scripts/
  // entry beside the reviewed checkout's public assets, not an incoming tree.
  await copyFile(
    path.join(directory, "application-release-private.bundle.mjs"),
    "scripts/application-release-private.bundle.mjs",
    1,
  );
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "build") await build();
  else if (process.argv[2] === "receive")
    await receiveApplicationTools(
      Number(process.env.PORTCOVE_TOOLS_ARTIFACT),
      Number(process.env.PORTCOVE_TOOLS_ATTEMPT),
    );
  else throw new Error("unknown fixed application tool operation");
}
