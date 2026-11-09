import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkStagedCatalog,
  catalogCoherenceInputs,
  generatedCatalogAggregates,
  resolveCatalogAggregateConflicts,
  catalogPortSourcePrefix,
} from "./catalog-staged-check.mts";
import {
  checkedCurrentCatalog,
  serializeCurrentCatalog,
  authoringRecordFromPort,
  assembleCatalogRecords,
} from "./catalog-authoring.mts";
import type { CurrentCatalog } from "./catalog-authoring.mts";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function writeFixtureSources(root: string, catalog: CurrentCatalog) {
  const shared: Record<string, unknown> = structuredClone(catalog);
  delete shared.ports;
  const records = catalog.ports.map((port, index) => authoringRecordFromPort(port, index));
  const directory = path.join(root, catalogPortSourcePrefix);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  for (const record of records)
    writeFileSync(path.join(directory, `${record.listing.id}.json`), JSON.stringify(record));
  writeFileSync(path.join(root, catalogCoherenceInputs[3]!), JSON.stringify(shared));
  writeFileSync(
    path.join(root, catalogCoherenceInputs[4]!),
    `${JSON.stringify(assembleCatalogRecords(shared, records).directory, null, 2)}\n`,
  );
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "catalog-index-"));
  git(root, "init", "-q");
  const catalog = {
    schema_version: 2 as const,
    source_catalog: {
      identities: [{ id: "legacy-profile" }, { id: "added-profile" }],
      contracts: [],
      evidence: [],
      qualification: [],
    },
    ports: ["legacy-port", "added-port"].map((id) => ({
      id,
      name: id,
      summary: "Fixture project",
      project_url: "https://example.org/project",
    })),
  };
  const documents = [
    catalog,
    { ports: [{ id: "legacy-port" }], source_profiles: [{ id: "legacy-profile" }] },
    { port_ids: ["added-port"], source_profile_ids: ["added-profile"] },
  ];
  for (const [index, file] of catalogCoherenceInputs.slice(0, 3).entries()) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, JSON.stringify(documents[index], null, 2) + "\n");
  }
  writeFixtureSources(root, catalog);
  git(root, "add", ".");
  return {
    root,
    catalog,
    embedded: path.join(root, catalogCoherenceInputs[0]!),
  };
}

void test("real indexed catalog check preserves partial staging and rejects a stale staged projection", () => {
  const f = fixture();
  try {
    const before = git(f.root, "ls-files", "--stage", "-z");
    f.catalog.ports[0] = { ...f.catalog.ports[0]!, id: "unstaged-port" };
    const working = JSON.stringify(f.catalog, null, 2) + "\n";
    writeFileSync(f.embedded, working);
    assert.deepEqual(checkStagedCatalog(f.root), { checked: true });
    assert.equal(readFileSync(f.embedded, "utf8"), working);
    assert.equal(git(f.root, "ls-files", "--stage", "-z"), before);
    // Matching worktree output cannot repair mismatched indexed input.
    writeFixtureSources(f.root, f.catalog);
    git(
      f.root,
      "add",
      catalogPortSourcePrefix,
      catalogCoherenceInputs[3]!,
      catalogCoherenceInputs[4]!,
    );
    writeFileSync(f.embedded, serializeCurrentCatalog(checkedCurrentCatalog(f.catalog)));
    assert.throws(() => checkStagedCatalog(f.root), /Indexed embedded catalog is stale/);
    git(f.root, "add", catalogCoherenceInputs[0]!);
    assert.throws(
      () => checkStagedCatalog(f.root),
      /compatibility fixture requires independent review/,
    );
    f.catalog.ports[0] = { ...f.catalog.ports[0], id: "legacy-port" };
    writeFileSync(f.embedded, serializeCurrentCatalog(checkedCurrentCatalog(f.catalog)));
    writeFixtureSources(f.root, f.catalog);
    git(f.root, "add", ".");
    assert.equal(checkStagedCatalog(f.root).checked, true);
    git(f.root, "rm", "--cached", catalogCoherenceInputs[2]!);
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
    writeFileSync(f.embedded, '{"schema_version":1}');
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

function conflictingMerge(root: string, files: readonly string[]) {
  const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.org"];
  const commit = (message: string) =>
    git(root, ...identity, "-c", "commit.gpgsign=false", "commit", "-qam", message);
  commit("base");
  const main = git(root, "branch", "--show-current").trim();
  git(root, "checkout", "-qb", "side");
  for (const file of files) writeFileSync(path.join(root, file), "side\n");
  commit("side");
  git(root, "checkout", "-q", main);
  for (const file of files) writeFileSync(path.join(root, file), "main\n");
  commit("main");
  const merged = spawnSync("git", [...identity, "merge", "--no-edit", "side"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(merged.status, 1, merged.stdout + merged.stderr);
}
function regenerated(root: string) {
  return (cwd: string) => {
    assert.equal(cwd, root);
    for (const file of generatedCatalogAggregates) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), `regenerated ${file}\n`);
    }
  };
}

void test("conflicted generated aggregates regenerate from sources and stage deterministically", () => {
  const f = fixture();
  try {
    const aggregates = [catalogCoherenceInputs[0]!, catalogCoherenceInputs[4]!];
    conflictingMerge(f.root, aggregates);
    assert.notEqual(git(f.root, "ls-files", "--unmerged"), "");
    const outcome = resolveCatalogAggregateConflicts(f.root, regenerated(f.root));
    assert.deepEqual([...outcome.resolved].sort(), [...aggregates].sort());
    assert.equal(git(f.root, "ls-files", "--unmerged"), "");
    for (const file of generatedCatalogAggregates)
      assert.equal(git(f.root, "show", `:${file}`), `regenerated ${file}\n`, file);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

void test("aggregate resolution refuses while an authored source conflict remains and never regenerates", () => {
  const f = fixture();
  try {
    const source = `${catalogPortSourcePrefix}legacy-port.json`;
    conflictingMerge(f.root, [catalogCoherenceInputs[0]!, source]);
    const before = git(f.root, "ls-files", "--stage", "-z");
    assert.throws(
      () =>
        resolveCatalogAggregateConflicts(f.root, () => {
          assert.fail("sources must be resolved before regeneration");
        }),
      (error: Error) =>
        error.message.includes(source) && !error.message.includes(catalogCoherenceInputs[0]!),
    );
    assert.equal(git(f.root, "ls-files", "--stage", "-z"), before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

void test("failed regeneration keeps aggregates unmerged and a clean index needs no work", () => {
  const f = fixture();
  try {
    assert.deepEqual(
      resolveCatalogAggregateConflicts(f.root, () => assert.fail("nothing to resolve")),
      { resolved: [] },
    );
    conflictingMerge(f.root, [catalogCoherenceInputs[0]!]);
    const before = git(f.root, "ls-files", "--stage", "-z");
    assert.throws(
      () =>
        resolveCatalogAggregateConflicts(f.root, () => {
          throw new Error("regeneration refused");
        }),
      /regeneration refused/,
    );
    assert.equal(git(f.root, "ls-files", "--stage", "-z"), before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
