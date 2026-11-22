import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  materializeGameLifecycleLibraries,
  type ReviewedGameLifecycleCase,
} from "./game-lifecycle-materializer.mts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const exe = "reviewed-executable";
const source = {
  custody: "reviewed-redistributable-fixture" as const,
  profile_id: "test-source",
  relative_path: "source-inbox/original.dat",
  sha256: sha("original"),
  storage_sha256: sha("original"),
  variant: { game_id: "test-source", variant_id: "original", representation_id: "binary" },
};
const exeIdentity = { relative_path: "game.exe", sha256: sha(exe) };
const base = {
  port_id: "exact-port",
  platform: "windows-x86-64" as const,
  channel: "stable" as const,
  source,
  predecessor_executable: exeIdentity,
  successor_executable: exeIdentity,
};
const definition = { namespace: "official", stable_id: base.port_id };
const predecessor = {
  definition,
  platform: base.platform,
  channel: base.channel,
  tag: "v1",
  artifact_sha256: sha("v1"),
  contract_id: "test-contract",
  variants: [source.variant],
};
const successor = { ...predecessor, tag: "v2", artifact_sha256: sha("v2") };
const prepared = {
  predecessor,
  successor,
  rule_version: 1,
  selected_at: 250,
  anchor_observations: [{ id: "exact-anchor" }],
};

void test("empty cohort and unavailable admissions require no filesystem or Core calls", async () => {
  const materialize = (cases: ReviewedGameLifecycleCase[]) =>
    materializeGameLifecycleLibraries({
      cli: { path: "nonexistent", sha256: sha("unavailable") },
      scratchRoot: "nonexistent",
      cases,
      runCli: async () => assert.fail("must not start Core"),
    });
  assert.deepEqual(await materialize([]), { work: [], holds: [] });
  const result = await materialize([
    { ...base, predecessor, successor, libraries: { state: "signed-admissions-unavailable" } },
  ]);
  assert.equal(result.work.length, 0);
  assert.equal(result.holds[0]?.reason, "independent-signed-library-admissions-unavailable");
});

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pc-game-operand-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, "core.exe");
  await writeFile(cli, "reviewed-core");
  for (const name of ["old", "new"]) {
    await mkdir(path.join(root, name, "versions"), { recursive: true });
    await mkdir(path.join(root, name, "source-inbox"));
    await writeFile(path.join(root, name, "versions", "game.exe"), exe);
    await writeFile(path.join(root, name, source.relative_path), "original");
  }
  const item: ReviewedGameLifecycleCase = {
    ...base,
    predecessor,
    successor,
    libraries: { state: "independently-admitted", predecessor: "old", successor: "new" },
  };
  const outcomes = {
    prepare: prepared,
    blocked: false,
    external: false,
    wrongRuntime: false,
    foreignGame: false,
    foreignVariant: false,
    replaceSource: false,
  };
  const commands: string[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const emit = (command: string, data: unknown) => JSON.stringify({ command, ok: true, data });
  const invoke = async (_cli: string, args: string[], _cwd: string, env: NodeJS.ProcessEnv) => {
    environments.push(env);
    const library = args[1]!;
    const name = args[4]!;
    commands.push(args.slice(4, 6).join(" "));
    const location = path.join(library, source.relative_path);
    switch (name) {
      case "catalog":
        assert.equal(args[7], "--predecessor-library");
        assert.equal(args[8], path.join(root, "old"));
        return outcomes.blocked
          ? JSON.stringify({ ok: false, error: { code: "withdrawn" } })
          : emit("catalog.prepare-successor-evidence", outcomes.prepare);
      case "status":
        return emit("status", {
          port_id: base.port_id,
          channel: base.channel,
          active: {
            id: "old-install",
            port_id: base.port_id,
            channel: base.channel,
            staged: false,
            verified: true,
            artifact: { sha256: sha("v1"), size: 9, asset_name: "v1.zip" },
            selected_executable: "game.exe",
            path: path.join(library, "versions"),
            version: outcomes.wrongRuntime ? "v2" : "v1",
          },
        });
      case "verify":
        return emit("verify", { valid: true, install_id: "old-install" });
      case "source":
        if (args[5] === "list")
          return emit("source.list", [{ ...source, path: outcomes.external ? cli : location }]);
        if (outcomes.replaceSource) {
          await rm(location);
          await writeFile(location, "original");
        }
        const exact = library === path.join(root, "old") ? predecessor : successor;
        return emit("source.verify", {
          ...source,
          path: location,
          storage_size: Buffer.byteLength("original"),
          inspection: {
            health: "current",
            inspection: {
              assessment: {
                classification: {
                  state: "recognized",
                  identity: outcomes.foreignVariant
                    ? { ...source.variant, variant_id: "wrong" }
                    : source.variant,
                },
                admission: { state: "admitted", mode: "exact_identity" },
              },
            },
            applications: [
              {
                port_id: outcomes.foreignGame ? "different-game" : base.port_id,
                role: "game",
                contract: {
                  id: exact.contract_id,
                  port_id: base.port_id,
                  role: "game",
                  profile_id: source.profile_id,
                  admission_mode: "enforced",
                  release_policy: "integration-contract-v1",
                },
                contract_result: { state: "supported", contract_id: exact.contract_id },
                release_applicability: {
                  reviewed_bindings: [
                    { upstream_ref: exact.tag, artifact_sha256: exact.artifact_sha256 },
                  ],
                },
              },
            ],
          },
        });
      default:
        return assert.fail("unexpected materializer command");
    }
  };
  return {
    item,
    commands,
    environments,
    outcomes,
    run: (overrides = {}) =>
      materializeGameLifecycleLibraries({
        cli: { path: cli, sha256: sha("reviewed-core") },
        scratchRoot: root,
        cases: [item],
        runCli: invoke,
        ...overrides,
      }),
  };
}

void test("materializes exact Core operands and intact predecessor in both owned libraries", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.deepEqual(result.holds, []);
  const [work] = result.work;
  assert.ok(work);
  assert.equal(sha(work.preparation_json), work.scope_sha256);
  assert.deepEqual(work.preparation, prepared);
  assert.notEqual(work.predecessor_library, work.successor_library);
  assert.equal(work.predecessor_active.executable_sha256, exeIdentity.sha256);
  assert.equal(work.successor_library_active.install_id, "old-install");
  assert.deepEqual(f.commands, [
    "catalog prepare-successor-evidence",
    "status exact-port",
    "verify exact-port",
    "source list",
    "source verify",
    "status exact-port",
    "verify exact-port",
    "source list",
    "source verify",
  ]);
});

void test("Core withdrawal and changed prepared coordinates leave no runnable operands", async (t) => {
  const f = await fixture(t);
  f.outcomes.blocked = true;
  const blocked = await f.run();
  assert.equal(blocked.work.length, 0);
  assert.equal(blocked.holds[0]?.reason, "exact-admission-or-live-selection-unavailable");
  f.outcomes.blocked = false;
  f.outcomes.prepare = { ...prepared, successor: { ...successor, tag: "unreviewed" } };
  assert.equal((await f.run()).work.length, 0);
  assert.deepEqual(f.commands, [
    "catalog prepare-successor-evidence",
    "catalog prepare-successor-evidence",
  ]);
});

void test("never verifies an external original or prepares unrelated installed packages", async (t) => {
  const f = await fixture(t);
  f.outcomes.external = true;
  assert.equal((await f.run()).work.length, 0);
  assert.equal(f.commands.includes("source verify"), false);
  f.commands.length = 0;
  f.outcomes.external = false;
  f.outcomes.wrongRuntime = true;
  assert.equal((await f.run()).work.length, 0);
  assert.equal(f.commands.includes("verify exact-port"), false);
});

void test("Core receives only isolated transport essentials and no ambient credentials", async (t) => {
  const f = await fixture(t);
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "PORTCOVE_SIGNING_SECRET",
    "https_proxy",
    "NODE_OPTIONS",
  ]) {
    const previous = process.env[key];
    process.env[key] = "ambient-fixture";
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  assert.equal((await f.run()).work.length, 1);
  const env = f.environments[0]!;
  assert.ok(
    Object.keys(env).every((key) =>
      [
        "SystemRoot",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
      ].includes(key),
    ),
  );
  assert.ok(env.HOME?.includes("pcg-"));
  assert.notEqual(env.APPDATA, process.env.APPDATA);
  assert.equal(
    f.environments.every((value) => value === env),
    true,
  );
});

void test("matching file bytes cannot substitute a foreign applied game or variant", async (t) => {
  const f = await fixture(t);
  for (const rejected of ["foreignGame", "foreignVariant", "replaceSource"] as const) {
    f.outcomes[rejected] = true;
    const result = await f.run();
    assert.equal(result.work.length, 0, rejected);
    assert.equal(result.holds[0]?.reason, "exact-predecessor-or-lawful-source-unavailable");
    f.outcomes[rejected] = false;
  }
});
