import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, link } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import { captureReleaseCompiler, releaseCompilerEnvironment } from "./release-compiler-capture.mts";

async function fixture(t: test.TestContext) {
  const f = await releasePublicBuildProvenanceFixture(t);
  await mkdir(path.join(f.root, "scripts"), { recursive: true });
  await writeFile(
    path.join(f.root, "scripts/release-compiler-capture.mts"),
    await readFile(new URL("release-compiler-capture.mts", import.meta.url)),
  );
  const cliRoot = path.join(f.root, "apps/desktop/node_modules/@tauri-apps/cli");
  await mkdir(cliRoot, { recursive: true });
  await writeFile(path.join(cliRoot, "package.json"), JSON.stringify({ version: "2.12.2" }));
  await writeFile(path.join(cliRoot, "tauri.js"), "process.exit(0);\n");
  await writeFile(path.join(cliRoot, "main.js"), "// inert fixture entry\n");
  await writeFile(path.join(cliRoot, "index.js"), "// inert fixture binding\n");
  const nativeRoot = path.join(path.dirname(cliRoot), "cli-linux-x64-gnu");
  await mkdir(nativeRoot);
  await writeFile(
    path.join(nativeRoot, "package.json"),
    JSON.stringify({ version: "2.12.2", main: "fixture.node" }),
  );
  await writeFile(path.join(nativeRoot, "fixture.node"), "inert bytes; never load as native code");
  await writeFile(path.join(f.root, "pnpm-lock.yaml"), "inert lock fixture\n");
  await writeFile(path.join(f.root, "Cargo.lock"), "inert lock fixture\n");
  await writeFile(path.join(f.root, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.99.1"\n');
  const overlay = path.join(f.root, "apps/desktop/src-tauri");
  await mkdir(overlay, { recursive: true });
  await writeFile(
    path.join(overlay, "tauri.release-public.conf.json"),
    await readFile(
      new URL("../apps/desktop/src-tauri/tauri.release-public.conf.json", import.meta.url),
    ),
  );
  const git = (args: string[]) =>
    execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8", timeout: 10000 }).trim();
  git(["init", "--quiet"]);
  git(["config", "core.autocrlf", "false"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=",
    "commit",
    "--quiet",
    "-m",
    "inert inputs",
  ]);
  return {
    ...f,
    options: {
      interface: "desktop" as const,
      inputDirectory: f.prepared.output,
      outputRoot: f.root,
      platform: "linux-x86_64" as const,
      expectedRevision: git(["rev-parse", "HEAD"]),
      expectedTree: git(["rev-parse", "HEAD^{tree}"]),
      configurationRevision: f.configuration.configuration_revision,
      manifestSha256: f.configuration.manifest_sha256,
      runId: "12345",
      runAttempt: 1,
    },
  };
}
void test("compiler child receives public toolchain/resource environment without role, OIDC or signing credentials", () => {
  assert.deepEqual(
    releaseCompilerEnvironment({
      PATH: "tools",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://issuer.invalid",
      TAURI_SIGNING_PRIVATE_KEY: "secret",
      NODE_OPTIONS: "--require candidate",
      PORTCOVE_RESOURCE_RESERVATION: "lease",
      PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "lock",
      CARGO_HOME: "cache",
    }),
    {
      PATH: "tools",
      PORTCOVE_RESOURCE_RESERVATION: "lease",
      PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "lock",
      CARGO_HOME: "cache",
    },
  );
});
void test("CLI uses the same source/toolchain capture while declaring updater inputs inapplicable", async (t) => {
  const f = await fixture(t);
  const result = await captureReleaseCompiler(f.root, {
    ...f.options,
    interface: "cli",
    invoke: async (executable, args, cwd) => {
      assert.equal(executable, "cargo");
      assert.equal(cwd, f.root);
      assert.deepEqual(args, ["build", "--release", "-p", "portcove-cli"]);
      return 0;
    },
  });
  assert.equal(result.report.interface, "cli");
  assert.match(result.report.public_input_use, /not applicable/);
  assert.equal(result.report.evidence_scope, "injected-executor");
});
void test("fresh CLI target is reused only by desktop for the exact same source/run/attempt", async (t) => {
  const f = await fixture(t);
  let target = "";
  const cli = await captureReleaseCompiler(f.root, {
    ...f.options,
    interface: "cli",
    invoke: async (_executable, _args, _cwd, environment) => {
      target = environment.CARGO_TARGET_DIR!;
      assert.equal(environment.CARGO_INCREMENTAL, "0");
      assert.equal(environment.CARGO_BUILD_JOBS, "4");
      assert.ok(path.isAbsolute(target));
      return 0;
    },
  });
  assert.equal(cli.report.target_directory, target);
  const desktop = await captureReleaseCompiler(f.root, {
    ...f.options,
    targetDirectory: target,
    invoke: async (_executable, _args, _cwd, environment) => {
      assert.equal(environment.CARGO_TARGET_DIR, target);
      return 0;
    },
  });
  assert.equal(desktop.report.state, "completed");
  let calls = 0;
  const invoke = async () => {
    calls++;
    return 0;
  };
  await assert.rejects(
    captureReleaseCompiler(f.root, {
      ...f.options,
      targetDirectory: target,
      runAttempt: 2,
      invoke,
    }),
    /different source\/run\/attempt/,
  );
  await assert.rejects(
    captureReleaseCompiler(f.root, {
      ...f.options,
      targetDirectory: target,
      interface: "cli",
      invoke,
    }),
    /requires a new private target/,
  );
  assert.equal(calls, 0);
});
void test("pnpm-style linked tool bytes retain physical identity while linked public inputs still refuse", async (t) => {
  const f = await fixture(t);
  const cli = path.join(f.root, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js");
  await link(cli, path.join(f.root, "owned-tool-link"));
  const result = await captureReleaseCompiler(f.root, { ...f.options, invoke: async () => 0 });
  assert.equal(result.report.state, "completed");
  assert.equal(
    result.report.tools.find((item) => item.role === "tauri-entrypoint")?.file_identity?.nlink,
    2,
  );
  await link(path.join(f.prepared.output, "root.json"), path.join(f.root, "owned-public-link"));
  let invoked = 0;
  await assert.rejects(
    captureReleaseCompiler(f.root, {
      ...f.options,
      invoke: async () => {
        invoked++;
        return 0;
      },
    }),
    /unlinked file/,
  );
  assert.equal(invoked, 0);
});
void test("direct inert process capture uses reconstructed exact inputs and never claims compiler acceptance", async (t) => {
  const f = await fixture(t);
  const result = await captureReleaseCompiler(f.root, {
    ...f.options,
    invoke: async (executable, args, cwd, environment) => {
      assert.deepEqual(args.slice(1, 5), ["build", "--bundles", "appimage,deb,rpm", "--no-sign"]);
      assert.equal(
        environment.PORTCOVE_APPLICATION_UPDATE_METADATA_URL,
        "https://boburning.github.io/portcove/application/metadata/",
      );
      assert.notEqual(
        environment.PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION,
        path.join(f.prepared.output, "tauri.release-public.conf.json"),
      );
      const child = spawnSync(executable, args, {
        cwd,
        env: environment,
        encoding: "utf8",
        timeout: 10000,
      });
      return child.status ?? 1;
    },
  });
  assert.equal(result.report.state, "completed");
  assert.equal(result.report.evidence_scope, "injected-executor");
  assert.equal(result.report.exit_code, 0);
  assert.match(result.report.original_compiler_acceptance, /unproven/);
  assert.ok(
    (
      await readFile(
        path.join(result.directory, "compiler-result-desktop-linux-x86_64.json"),
        "utf8",
      )
    ).includes('"authority": "none"'),
  );
});
void test("actual child refusal retains started and failed results with partial effects", async (t) => {
  const f = await fixture(t);
  const result = await captureReleaseCompiler(f.root, {
    ...f.options,
    invoke: async (executable, args, cwd, environment) => {
      const child = spawnSync(executable, ["-e", "process.exit(7)"], {
        cwd,
        env: environment,
        timeout: 10000,
      });
      return child.status ?? 1;
    },
  });
  assert.equal(result.report.state, "failed");
  assert.equal(result.report.exit_code, 7);
  assert.match(
    await readFile(
      path.join(result.directory, "compiler-observation-desktop-linux-x86_64.json"),
      "utf8",
    ),
    /'started'|"started"/,
  );
  assert.match(result.report.failure ?? "", /partial outputs remain unaccepted/);
});
void test("changed public bytes and source refuse before invocation; mutation during process remains failed", async (t) => {
  const f = await fixture(t);
  let invoked = 0;
  await assert.rejects(
    captureReleaseCompiler(f.root, {
      ...f.options,
      expectedRevision: "0".repeat(40),
      invoke: async () => {
        invoked++;
        return 0;
      },
    }),
    /reviewed source/,
  );
  assert.equal(invoked, 0);
  const result = await captureReleaseCompiler(f.root, {
    ...f.options,
    invoke: async (_executable, args) => {
      invoked++;
      await writeFile(args.at(-1)!, "changed");
      return 0;
    },
  });
  assert.equal(result.report.state, "failed");
  assert.match(result.report.failure ?? "", /changed during actual invocation/);
});
