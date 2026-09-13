#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exactSha = (value) => /^[a-f0-9]{40}$/u.test(value ?? "");
const exactPositiveInteger = (value) => /^[1-9]\d*$/u.test(value ?? "");

function command(commandName, args, cwd = root) {
  return execFileSync(commandName, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  }).trim();
}

function rustVersion(value, commandName) {
  const match = new RegExp(`^${commandName} (\\d+\\.\\d+\\.\\d+)\\b`, "u").exec(value);
  if (!match) throw new Error(`Unable to parse observed ${commandName} version`);
  return match[1];
}

export function buildWorkflowProvenance({
  workflow,
  mode,
  desiredRunner,
  workflowContents,
  desired,
  observed,
  environment,
  checkoutSha,
}) {
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/u.test(workflow)) throw new Error("Invalid workflow filename");
  if (!exactSha(environment.GITHUB_WORKFLOW_SHA))
    throw new Error("GITHUB_WORKFLOW_SHA must identify the workflow-file source commit");
  if (!exactSha(environment.GITHUB_SHA))
    throw new Error("GITHUB_SHA must identify the triggering workflow commit");
  if (!exactSha(checkoutSha)) throw new Error("Checked-out code SHA is unavailable");
  if (!exactPositiveInteger(environment.GITHUB_RUN_ID)) throw new Error("Invalid GITHUB_RUN_ID");
  if (!exactPositiveInteger(environment.GITHUB_RUN_ATTEMPT))
    throw new Error("Invalid GITHUB_RUN_ATTEMPT");
  const expectedRefPrefix = `${environment.GITHUB_REPOSITORY}/.github/workflows/${workflow}@`;
  if (!environment.GITHUB_WORKFLOW_REF?.startsWith(expectedRefPrefix))
    throw new Error("GITHUB_WORKFLOW_REF does not identify the selected repository workflow");
  if (checkoutSha !== environment.GITHUB_SHA)
    throw new Error("Checked-out code does not match GITHUB_SHA");
  const matches = {
    node: desired.node === observed.node,
    package_manager: desired.package_manager === observed.package_manager,
    rust: desired.rust === observed.rust,
    cargo: desired.rust === observed.cargo,
    build_configuration:
      JSON.stringify(desired.build_configuration) === JSON.stringify(observed.build_configuration),
  };
  if (Object.values(matches).includes(false))
    throw new Error(
      `Observed workflow configuration differs from desired: ${JSON.stringify(matches)}`,
    );
  const record = {
    format_version: 1,
    run: {
      id: Number(environment.GITHUB_RUN_ID),
      attempt: Number(environment.GITHUB_RUN_ATTEMPT),
      event: environment.GITHUB_EVENT_NAME,
    },
    workflow: {
      path: `.github/workflows/${workflow}`,
      ref: environment.GITHUB_WORKFLOW_REF,
      source_sha: environment.GITHUB_WORKFLOW_SHA,
      content_sha256: sha256(workflowContents),
    },
    checkout: { sha: checkoutSha, github_sha: environment.GITHUB_SHA },
    desired: { runner: desiredRunner, mode, ...desired },
    observed,
    matches,
  };
  const cohortInputs = {
    workflow: record.workflow,
    checkout: record.checkout,
    desired: record.desired,
    observed: record.observed,
  };
  return { ...record, equivalent_cohort: sha256(JSON.stringify(cohortInputs)) };
}

export function parseProvenanceArchive(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > 2 * 1024 * 1024)
    throw new Error("Invalid provenance artifact archive size");
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Missing provenance artifact ZIP directory");
  const entries = archive.readUInt16LE(end + 10);
  const directoryOffset = archive.readUInt32LE(end + 16);
  let cursor = directoryOffset;
  const matches = [];
  for (let index = 0; index < entries; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Malformed provenance artifact ZIP directory");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === "workflow-provenance.json") {
      if (flags & 1) throw new Error("Encrypted provenance artifacts are unsupported");
      if (![0, 8].includes(method) || uncompressedSize > 1024 * 1024)
        throw new Error("Unsupported provenance artifact compression");
      if (archive.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error("Malformed provenance artifact ZIP entry");
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      const contents = method === 0 ? compressed : inflateRawSync(compressed);
      if (contents.length !== uncompressedSize)
        throw new Error("Provenance artifact size mismatch");
      matches.push(contents);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (matches.length !== 1) throw new Error("Provenance artifact must contain one JSON record");
  return JSON.parse(matches[0].toString("utf8"));
}

export function validateWorkflowProvenance(record, { runId, attempt, headSha }) {
  if (
    record?.format_version !== 1 ||
    record.run?.id !== runId ||
    record.run?.attempt !== attempt ||
    record.checkout?.sha !== headSha ||
    record.checkout?.github_sha !== headSha ||
    !exactSha(record.workflow?.source_sha) ||
    !/^[a-f0-9]{64}$/u.test(record.workflow?.content_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(record.equivalent_cohort ?? "") ||
    Object.values(record.matches ?? {}).some((matches) => matches !== true)
  )
    throw new Error("Provenance artifact identity or configuration mismatch");
  return record;
}

async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      workflow: { type: "string" },
      mode: { type: "string" },
      runner: { type: "string" },
      output: { type: "string" },
    },
  });
  if (
    !values.workflow ||
    !["ci", "release"].includes(values.mode) ||
    !values.runner ||
    !values.output
  )
    throw new Error(
      "Usage: workflow-provenance --workflow FILE --mode ci|release --runner LABEL --output FILE",
    );
  const node = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const desktopPackage = JSON.parse(
    await readFile(path.join(root, "apps/desktop/package.json"), "utf8"),
  );
  const rustToolchain = (await readFile(path.join(root, "rust-toolchain.toml"), "utf8")).match(
    /^channel = "([^"]+)"$/mu,
  )?.[1];
  if (!rustToolchain) throw new Error("Unable to read desired Rust toolchain");
  const expectedBuildConfiguration = {
    ci: true,
    cargo_profile_dev_debug: values.mode === "ci" ? "line-tables-only" : null,
    cargo_profile_test_debug: values.mode === "ci" ? "line-tables-only" : null,
  };
  const packageManagerVersion = command(
    "corepack",
    ["pnpm", "--version"],
    path.join(root, "apps/desktop"),
  );
  const record = buildWorkflowProvenance({
    workflow: values.workflow,
    mode: values.mode,
    desiredRunner: values.runner,
    workflowContents: await readFile(path.join(root, ".github/workflows", values.workflow)),
    desired: {
      node,
      package_manager: desktopPackage.packageManager.replace(/^pnpm@/u, ""),
      rust: rustToolchain,
      build_configuration: expectedBuildConfiguration,
    },
    observed: {
      node: process.version.replace(/^v/u, ""),
      package_manager: packageManagerVersion,
      rust: rustVersion(command("rustc", ["--version"]), "rustc"),
      cargo: rustVersion(command("cargo", ["--version"]), "cargo"),
      runner: {
        os: process.env.RUNNER_OS,
        architecture: process.env.RUNNER_ARCH,
      },
      build_configuration: {
        ci: process.env.CI === "true",
        cargo_profile_dev_debug: process.env.CARGO_PROFILE_DEV_DEBUG ?? null,
        cargo_profile_test_debug: process.env.CARGO_PROFILE_TEST_DEBUG ?? null,
      },
    },
    environment: process.env,
    checkoutSha: command("git", ["rev-parse", "HEAD"]),
  });
  await writeFile(path.resolve(values.output), `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(`Recorded workflow provenance cohort ${record.equivalent_cohort}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
