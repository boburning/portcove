import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkStagedCatalog, catalogCoherenceInputs } from "./catalog-staged-check.mts";
import { checkedCurrentCatalog, serializeCurrentCatalog } from "./catalog-authoring.mts";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "catalog-index-"));
  git(root, "init", "-q");
  const catalog = {
    schema_version: 2,
    ports: [{ id: "legacy-port" }, { id: "added-port" }],
    source_catalog: {
      identities: [{ id: "legacy-profile" }, { id: "added-profile" }],
      contracts: [],
      evidence: [],
      qualification: [],
    },
  };
  const documents = [
    catalog,
    catalog,
    { ports: [{ id: "legacy-port" }], source_profiles: [{ id: "legacy-profile" }] },
    { port_ids: ["added-port"], source_profile_ids: ["added-profile"] },
  ];
  for (const [index, file] of catalogCoherenceInputs.entries()) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, JSON.stringify(documents[index], null, 2) + "\n");
  }
  git(root, "add", ".");
  return {
    root,
    catalog,
    authoring: path.join(root, catalogCoherenceInputs[0]!),
    embedded: path.join(root, catalogCoherenceInputs[1]!),
  };
}

void test("real indexed catalog check preserves partial staging and rejects a stale staged projection", () => {
  const f = fixture();
  try {
    const before = git(f.root, "ls-files", "--stage", "-z");
    f.catalog.ports[0] = { id: "unstaged-port" };
    const working = JSON.stringify(f.catalog, null, 2) + "\n";
    writeFileSync(f.authoring, working);
    assert.deepEqual(checkStagedCatalog(f.root), { checked: true });
    assert.equal(readFileSync(f.authoring, "utf8"), working);
    assert.equal(git(f.root, "ls-files", "--stage", "-z"), before);
    // Matching worktree output cannot repair mismatched indexed input.
    git(f.root, "add", catalogCoherenceInputs[0]!);
    writeFileSync(f.embedded, serializeCurrentCatalog(checkedCurrentCatalog(f.catalog)));
    assert.throws(() => checkStagedCatalog(f.root), /Indexed embedded catalog is stale/);
    git(f.root, "add", catalogCoherenceInputs[1]!);
    assert.throws(
      () => checkStagedCatalog(f.root),
      /compatibility fixture requires independent review/,
    );
    f.catalog.ports[0] = { id: "legacy-port" };
    writeFileSync(f.authoring, JSON.stringify(f.catalog, null, 2) + "\n");
    writeFileSync(f.embedded, serializeCurrentCatalog(checkedCurrentCatalog(f.catalog)));
    git(f.root, "add", ".");
    assert.equal(checkStagedCatalog(f.root).checked, true);
    git(f.root, "rm", "--cached", catalogCoherenceInputs[3]!);
    assert.throws(() => checkStagedCatalog(f.root), /input is missing/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

void test("unrelated staging needs no catalog; symlink index modes and malformed authoring fail", () => {
  const f = fixture();
  try {
    const file = catalogCoherenceInputs[0]!;
    const oid = git(f.root, "rev-parse", `:${file}`).trim();
    git(f.root, "update-index", "--cacheinfo", `120000,${oid},${file}`);
    assert.throws(() => checkStagedCatalog(f.root), /regular stage-zero/);
    git(f.root, "update-index", "--cacheinfo", `100644,${oid},${file}`);
    writeFileSync(f.authoring, '{"schema_version":1}');
    git(f.root, "add", file);
    assert.throws(() => checkStagedCatalog(f.root), /not schema 2/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
  const root = mkdtempSync(path.join(tmpdir(), "catalog-unrelated-"));
  try {
    git(root, "init", "-q");
    writeFileSync(path.join(root, "unrelated.txt"), "unrelated\n");
    git(root, "add", ".");
    assert.deepEqual(checkStagedCatalog(root), { checked: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("conflicted index entries are refused without changing index bytes", () => {
  const f = fixture();
  try {
    const file = catalogCoherenceInputs[0]!;
    const oid = git(f.root, "rev-parse", `:${file}`).trim();
    const result = spawnSync("git", ["update-index", "--index-info"], {
      cwd: f.root,
      encoding: "utf8",
      windowsHide: true,
      input: `0 ${"0".repeat(40)}\t${file}\n100644 ${oid} 1\t${file}\n100644 ${oid} 2\t${file}\n100644 ${oid} 3\t${file}\n`,
    });
    assert.equal(result.status, 0, result.stderr);
    const before = git(f.root, "ls-files", "--stage", "-z");
    assert.throws(() => checkStagedCatalog(f.root), /unmerged index/);
    assert.equal(git(f.root, "ls-files", "--stage", "-z"), before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
