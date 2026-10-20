/** Ordinary credential-free hosted build fixture. Never a production tool route. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildControllerTools } from "./release-controller-tool-build.mts";
import {
  controllerToolEntries,
  controllerCompilerSourceAsset,
  readControllerToolFile,
} from "./release-controller-tools.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source-closure.mts";

async function main() {
  const source = fileURLToPath(new URL("..", import.meta.url));
  const temp = process.env.RUNNER_TEMP;
  if (process.argv.length !== 2 || process.platform !== "linux" || !temp || !path.isAbsolute(temp))
    throw new Error("fixed Linux hosted build fixture required");
  const directory = path.join(temp, "controller-tool-build-fixture");
  await mkdir(directory, { mode: 0o700 });
  const buildWork = path.join(directory, "build-work");
  await mkdir(buildWork, { mode: 0o700 });
  let phase = "source";
  const record = (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 64 * 1024) throw new Error("fixture public evidence exceeds bound");
    return writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  };
  let builtDirectory: string | null = null;
  try {
    const git = (argument: string) => {
      const result = spawnSync("git", ["rev-parse", argument], {
        cwd: source,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      if (result.status !== 0 || result.error) throw new Error("fixture source unavailable");
      return result.stdout.trim();
    };
    const expected = { commit: git("HEAD"), tree: git("HEAD^{tree}") };
    assert.equal(expected.commit, process.env.FIXTURE_SOURCE_SHA);
    await record("source.json", {
      schema_version: 1,
      ...expected,
      evidence_scope: "ordinary-hosted-fixture",
      authority: "none",
    });
    phase = "actual-fixed-build";
    const built = await buildControllerTools(source, buildWork, expected);
    builtDirectory = built.directory;
    await record("manifest.json", built.manifest);
    phase = "opaque-tool-readback";
    for (const file of built.manifest.files) {
      const bytes = await readControllerToolFile(path.join(built.tools, file.path));
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    phase = "actual-compiler-source-closure";
    const closure = inspectReleaseCompilerSourceClosure(
      JSON.parse(
        (
          await readControllerToolFile(path.join(built.tools, controllerCompilerSourceAsset), 65536)
        ).toString("utf8"),
      ) as unknown,
    );
    assert.equal(closure.source_commit, expected.commit);
    assert.equal(closure.source_tree, expected.tree);
    const env = {
      HOME: directory,
      USERPROFILE: directory,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    };
    const invoke = (executable: string, args: string[]) =>
      spawnSync(executable, args, {
        cwd: built.tools,
        env,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    phase = "actual-node-runtime";
    const node = path.join(built.tools, "bin/node");
    const nodeResult = invoke(node, ["--version"]);
    assert.equal(nodeResult.error, undefined);
    assert.equal(nodeResult.status, 0);
    assert.equal(nodeResult.stdout.trim(), "v24.22.0");
    phase = "actual-tauri-addon-help";
    const addon = path.join(built.tools, "bin/tauri-addon.node");
    const tauri = (args: string[]) =>
      invoke(node, [
        "-e",
        'require(process.argv[1]).run(JSON.parse(process.argv[2]),"tauri",e=>{if(e)process.exitCode=1})',
        addon,
        JSON.stringify(args),
      ]);
    const version = tauri(["--version"]);
    assert.equal(version.error, undefined);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "tauri-cli 2.12.2");
    const signHelp = tauri(["signer", "sign", "--help"]);
    assert.equal(signHelp.error, undefined);
    assert.equal(signHelp.status, 0);
    assert.match(signHelp.stdout, /--app-version/u);
    const buildHelp = tauri(["build", "--help"]);
    assert.equal(buildHelp.error, undefined);
    assert.equal(buildHelp.status, 0);
    assert.match(buildHelp.stdout, /--no-sign/u);
    phase = "actual-bundle-refusal-smoke";
    for (const name of controllerToolEntries) {
      const result = invoke(node, [path.join(built.tools, "scripts", `${name}.bundle.mjs`)]);
      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        ["release-control-ready", "release-payload-preparation"].includes(name) ? 2 : 1,
        name,
      );
      assert.ok(result.stderr.trim(), name);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
    }
    phase = "actual-rust-refusal-smoke";
    const rust = invoke(path.join(built.tools, "bin/portcove-release-tools"), []);
    assert.equal(rust.error, undefined);
    assert.equal(rust.status, 1);
    assert.match(rust.stderr, /usage: portcove-release-tools/u);
    phase = "complete";
    await record("result.json", {
      schema_version: 1,
      status: "pass",
      phase,
      built_directory: builtDirectory,
      build_work: buildWork,
      source: expected,
      evidence_scope: "ordinary-hosted-fixture",
      rust_smoke: "usage-refusal-only",
      tauri_smoke: "version-and-supported-sign-build-flags-only",
      node_bundles: controllerToolEntries,
      production_tool_acceptance: "not-established",
      authority: "none",
    });
  } catch {
    await record("result.json", {
      schema_version: 1,
      status: "fail",
      phase,
      built_directory: builtDirectory,
      build_work: buildWork,
      evidence_scope: "ordinary-hosted-fixture",
      production_tool_acceptance: "not-established",
      authority: "none",
    });
    throw new Error(`controller tool build fixture refused; retain ${directory}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "controller tool build fixture refused");
    process.exitCode = 2;
  });
