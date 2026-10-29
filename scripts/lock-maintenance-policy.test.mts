import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  maintenanceIdentity,
  maintenanceSource,
  introducedCargo,
  runMaintenancePolicy,
} from "./lock-maintenance-policy.mts";
import {
  MaintenanceRegistry,
  publicationMilliseconds,
  integrityParts,
  maintenanceLimits,
  maintenanceAgePolicy,
} from "./lock-maintenance-registry.mts";
import type { MaintenanceArtifact } from "./lock-maintenance-registry.mts";
import {
  lockInventory,
  registrySnapshotCoverage,
  introducedPackages,
} from "./pnpm-lock-inventory.mts";
import { stringify, parseAllDocuments } from "yaml";
import { isRecord } from "./runtime-values.mts";
import { readdirSync } from "node:fs";

function fixtureRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function fixtureArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function requiredFixture<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
function requestUrl(value: string | URL | Request) {
  return typeof value === "string" ? value : value instanceof URL ? value.href : value.url;
}
function npmMetadata(a: MaintenanceArtifact, published: string) {
  return {
    name: a.name,
    time: { [a.version]: published },
    versions: {
      [a.version]: {
        name: a.name,
        version: a.version,
        dist: {
          integrity: a.integrity,
          tarball: `https://registry.npmjs.org/${a.name}/-/shape-${a.version}.tgz`,
        },
      },
    },
  };
}
const source = "a".repeat(40),
  target = "b".repeat(40);
function event() {
  return {
    pull_request: {
      user: { login: "renovate[bot]" },
      head: {
        sha: source,
        ref: "renovate/lock-file-maintenance",
        repo: { full_name: "boburning/portcove" },
      },
      base: { sha: target, ref: "main", repo: { full_name: "boburning/portcove" } },
      body: "| Update | Change |\n|---|---|\n| lockFileMaintenance | All locks refreshed |",
    },
  };
}
void test("canonical maintenance cannot lose identity through body, labels, author or source ambiguity", () => {
  assert.equal(maintenanceIdentity(event()).applicable, true);
  for (const mutate of [
    (e: ReturnType<typeof event>) => {
      e.pull_request.body = "";
    },
    (e: ReturnType<typeof event>) => {
      e.pull_request.body += "\n| lockFileMaintenance | duplicate |";
    },
    (e: ReturnType<typeof event>) => {
      e.pull_request.user.login = "someone";
    },
    (e: ReturnType<typeof event>) => {
      e.pull_request.head.repo.full_name = "other/fork";
    },
    (e: ReturnType<typeof event>) => {
      e.pull_request.base.ref = "other";
    },
    (e: ReturnType<typeof event>) => {
      e.pull_request.head.sha = "main";
    },
  ]) {
    const e = event();
    mutate(e);
    assert.throws(() => maintenanceIdentity(e));
  }
  const mismatched = event();
  mismatched.pull_request.head.ref = "renovate/other";
  assert.throws(() => maintenanceIdentity(mismatched), /conflicts/);
  const manual = event();
  manual.pull_request.head.ref = "feature/manual";
  manual.pull_request.user.login = "person";
  assert.equal(maintenanceIdentity(manual).applicable, false);
  const direct = event();
  direct.pull_request.head.ref = "renovate/some-package";
  direct.pull_request.body = "minor update";
  assert.equal(maintenanceIdentity(direct).applicable, false);
});
void test("source guard checks the actual delta before setup and binds source to checkout", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "maintenance-source-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    writeFileSync(path.join(cwd, "Cargo.lock"), "version = 4\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(cwd, "Cargo.lock"), "version = 4\n# changed\n");
    git("commit", "-am", "lock");
    const head = git("rev-parse", "HEAD");
    assert.deepEqual(maintenanceSource(cwd, { applicable: true, head, target: base }).paths, [
      "Cargo.lock",
    ]);
    writeFileSync(path.join(cwd, "package.json"), "{}");
    git("add", ".");
    git("commit", "-m", "manifest");
    assert.throws(
      () =>
        maintenanceSource(cwd, { applicable: true, head: git("rev-parse", "HEAD"), target: base }),
      /more than supported locks/,
    );
    assert.throws(() => maintenanceSource(cwd, { applicable: true, head: source, target: base }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
const payload = Buffer.from("registry fixture bytes");
function artifact(manager: "cargo" | "npm" = "cargo"): MaintenanceArtifact {
  const algorithm = manager === "cargo" ? "sha256" : "sha512";
  return {
    manager,
    name: manager === "cargo" ? "shape" : "@scope/shape",
    version: "1.2.3",
    integrity: `${algorithm}-${createHash(algorithm).update(payload).digest("base64")}`,
  };
}
const now = Date.parse("2026-10-29T16:18:44.286Z");
function requestFixture(a: MaintenanceArtifact, published: string, corrupt = false): typeof fetch {
  return async (url: string | URL | Request) => {
    const value = requestUrl(url);
    if (value.startsWith("https://static.crates.io/") || value.endsWith(".tgz"))
      return new Response(corrupt ? "changed" : payload);
    if (a.manager === "cargo")
      return Response.json({
        version: {
          crate: a.name,
          num: a.version,
          yanked: false,
          created_at: published,
          checksum: createHash("sha256").update(payload).digest("hex"),
        },
      });
    return Response.json(npmMetadata(a, published));
  };
}
void test("microsecond publication boundary rounds conservatively and requires a real timestamp", () => {
  assert.equal(
    publicationMilliseconds("2026-10-28T15:48:44.285686Z"),
    now - maintenanceLimits.ageMs,
  );
  assert.equal(maintenanceLimits.ageMs, 88_200_000);
  assert.equal(maintenanceAgePolicy.minimumReleaseAgeBufferMs, 1_800_000);
  for (const bad of [undefined, "yesterday", "2026-02-30T00:00:00Z", "2026-10-28T15:48:44+01:00"])
    assert.throws(() => publicationMilliseconds(bad));
});
void test("both managers accept exact boundary with actual bytes and reject young or corrupt input", async (t) => {
  t.mock.method(Date, "now", () => now);
  for (const manager of ["cargo", "npm"] as const) {
    const a = artifact(manager);
    const accepted = await new MaintenanceRegistry(
      requestFixture(a, "2026-10-28T15:48:44.285686Z"),
    ).verify(a);
    assert.equal(accepted.age, "eligible");
    assert.equal(accepted.archiveVerified, true);
    t.mock.method(Date, "now", () => now - maintenanceAgePolicy.minimumReleaseAgeBufferMs);
    const atUnbufferedBoundary = await new MaintenanceRegistry(
      requestFixture(a, "2026-10-28T15:48:44.285686Z"),
    ).verify(a);
    assert.equal(atUnbufferedBoundary.age, "young");
    assert.equal(atUnbufferedBoundary.archiveVerified, false);
    t.mock.method(Date, "now", () => now - 1);
    const beforeEffectiveBoundary = await new MaintenanceRegistry(
      requestFixture(a, "2026-10-28T15:48:44.285686Z"),
    ).verify(a);
    assert.equal(beforeEffectiveBoundary.age, "young");
    assert.equal(beforeEffectiveBoundary.archiveBytes, 0);
    t.mock.method(Date, "now", () => now);
    const young = await new MaintenanceRegistry(
      requestFixture(a, "2026-10-28T15:48:44.286001Z"),
    ).verify(a);
    assert.equal(young.age, "young");
    assert.equal(young.archiveVerified, false);
    assert.equal(young.archiveBytes, 0);
    await assert.rejects(
      new MaintenanceRegistry(requestFixture(a, "2026-10-27T00:00:00Z", true)).verify(a),
      /integrity mismatch/,
    );
    await assert.rejects(
      new MaintenanceRegistry(requestFixture(a, "2026-10-30T00:00:00Z")).verify(a),
      /future/,
    );
  }
});
void test("registry identity, source, metadata, strong SRI and transport fail closed", async (t) => {
  t.mock.method(Date, "now", () => now);
  for (const body of [
    { version: { crate: "wrong", num: "1.2.3", yanked: false } },
    { version: { crate: "shape", num: "1.2.3", yanked: true } },
    { version: { crate: "shape", num: "1.2.3", yanked: false, checksum: "a".repeat(64) } },
  ])
    await assert.rejects(
      new MaintenanceRegistry(async () => Response.json(body)).verify(artifact()),
    );
  await assert.rejects(
    new MaintenanceRegistry(async () => new Response("limited", { status: 429 })).verify(
      artifact(),
    ),
    /HTTP 429/,
  );
  await assert.rejects(
    new MaintenanceRegistry(async () => {
      throw new Error("timeout");
    }).verify(artifact()),
    /timeout/,
  );
  const npm = artifact("npm");
  const weak = {
    name: npm.name,
    time: { [npm.version]: "2026-10-27T00:00:00Z" },
    versions: {
      [npm.version]: {
        name: npm.name,
        version: npm.version,
        dist: { shasum: "a".repeat(40), tarball: "https://evil.invalid/file" },
      },
    },
  };
  await assert.rejects(
    new MaintenanceRegistry(async () => Response.json(weak)).verify(npm),
    /downgrade/,
  );
  assert.throws(() => integrityParts("sha512-YQ=="));
  await assert.rejects(
    new MaintenanceRegistry().verify({ ...npm, name: "https://evil.invalid" }),
    /identity/,
  );
  await assert.rejects(
    new MaintenanceRegistry().verify({ ...npm, name: "LegacyUppercase" }),
    /identity/,
  );
  for (const mutate of [
    (p: {
      time?: unknown;
      versions: Record<string, { version: string; dist: { integrity?: string; tarball: string } }>;
    }) => {
      delete p.time;
    },
    (p: {
      time?: unknown;
      versions: Record<string, { version: string; dist: { integrity?: string; tarball: string } }>;
    }) => {
      requiredFixture(p.versions[npm.version]).version = "9.9.9";
    },
    (p: {
      time?: unknown;
      versions: Record<string, { version: string; dist: { integrity?: string; tarball: string } }>;
    }) => {
      delete requiredFixture(p.versions[npm.version]).dist.integrity;
    },
    (p: {
      time?: unknown;
      versions: Record<string, { version: string; dist: { integrity?: string; tarball: string } }>;
    }) => {
      requiredFixture(p.versions[npm.version]).dist.tarball = "https://evil.invalid/archive";
    },
  ]) {
    const request = (async () => {
      const p = npmMetadata(npm, "2026-10-27T00:00:00Z");
      mutate(p);
      return Response.json(p);
    }) as typeof fetch;
    await assert.rejects(new MaintenanceRegistry(request).verify(npm));
  }
});
void test("actual streamed metadata/archive byte bounds and overall deadline reject execution", async (t) => {
  t.mock.method(Date, "now", () => now);
  const oversized = (count: number) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(count));
          controller.close();
        },
      }),
    );
  await assert.rejects(
    new MaintenanceRegistry(async () => oversized(maintenanceLimits.metadataBytes + 1)).verify(
      artifact(),
    ),
    /metadata byte budget/,
  );
  const request = (async (url: string | URL | Request) =>
    requestUrl(url).startsWith("https://static.crates.io/")
      ? oversized(maintenanceLimits.archiveBytes + 1)
      : requestFixture(artifact(), "2026-10-27T00:00:00Z")(url)) as typeof fetch;
  await assert.rejects(new MaintenanceRegistry(request).verify(artifact()), /archive byte budget/);
  await assert.rejects(
    new MaintenanceRegistry(async () => new Response("{")).verify(artifact()),
    /JSON/,
  );
  const expired = new MaintenanceRegistry(requestFixture(artifact(), "2026-10-27T00:00:00Z"));
  t.mock.method(Date, "now", () => now + maintenanceLimits.totalMs + 1);
  await assert.rejects(expired.verify(artifact()), /deadline expired/);
});
void test("Cargo deltas account for unchanged Git identities and refuse changed unaged authorities", () => {
  const existing = {
    name: "git-source",
    version: "1.0.0",
    source: "git+https://example.invalid#a",
  };
  assert.deepEqual(introducedCargo([existing], [existing]), []);
  assert.throws(() => introducedCargo([], [existing]), /controlled source review/);
  assert.equal(
    introducedCargo(
      [],
      [
        {
          name: "shape",
          version: "1.2.3",
          source: "registry+https://github.com/rust-lang/crates.io-index",
          checksum: "a".repeat(64),
        },
      ],
    ).length,
    1,
  );
});
void test("complete TOML parser refuses duplicate keys, unsupported records and missing integrity", () => {
  const parser = fileURLToPath(new URL("./cargo-lock-inventory.py", import.meta.url));
  const run = (input: string) =>
    execFileSync(process.platform === "win32" ? "python" : "python3", ["-I", parser], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  const parsed: unknown = JSON.parse(
    run('version = 4\n[[package]]\nname = "local"\nversion = "1.0.0"\n'),
  );
  assert.equal(fixtureArray(parsed).length, 1);
  for (const input of [
    "version = 4\nversion = 4\n",
    'version = 4\n[[package]]\nname = "crate"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    "version = 5\n",
    'version = 4\n[[package]]\nname = "bad/name"\nversion = "1.0.0"\n',
  ])
    assert.throws(() => run(input));
});
void test("required maintenance execution binds complete inventories and never accepts a young or no-op run", async (t) => {
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", requestFixture(artifact(), "2026-10-28T15:48:44.286001Z"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "maintenance-policy-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const variables = [
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
  ];
  const previous = Object.fromEntries(variables.map((k) => [k, process.env[k]]));
  try {
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"])
      writeFileSync(path.join(cwd, file), readFileSync(new URL(`../${file}`, import.meta.url)));
    writeFileSync(path.join(cwd, "Cargo.lock"), "version = 4\npackage = []\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const checksum = createHash("sha256").update(payload).digest("hex");
    writeFileSync(
      path.join(cwd, "Cargo.lock"),
      `version = 4\n[[package]]\nname = "shape"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n`,
    );
    git("commit", "-am", "lock");
    const head = git("rev-parse", "HEAD");
    const e = event();
    e.pull_request.head.sha = head;
    e.pull_request.base.sha = base;
    const file = path.join(cwd, "event.json");
    writeFileSync(file, JSON.stringify(e));
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = file;
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;
    await assert.rejects(runMaintenancePolicy("check", cwd), /24-hour-plus-30-minute boundary/);
    const reports = () =>
      readdirSync(path.join(cwd, "work/dependency-policy")).map((p) => {
        const value: unknown = JSON.parse(
          readFileSync(path.join(cwd, "work/dependency-policy", p), "utf8"),
        );
        return fixtureRecord(value);
      });
    const young = requiredFixture(reports()[0]);
    assert.equal(young.acceptance, false);
    assert.equal(young.execution, "age-check-executed");
    assert.equal(
      fixtureRecord(fixtureRecord(fixtureArray(young.inventories)[1]).closure).documents,
      2,
    );
    assert.equal(fixtureArray(young.observations).length, 1);
    t.mock.method(globalThis, "fetch", requestFixture(artifact(), "2026-10-27T00:00:00Z"));
    await runMaintenancePolicy("check", cwd);
    assert.equal(reports().filter((r) => r.acceptance === true).length, 1);
    t.mock.method(globalThis, "fetch", (async () => {
      throw new Error("interrupted transport");
    }) as typeof fetch);
    await assert.rejects(runMaintenancePolicy("check", cwd), /interrupted transport/);
    assert.equal(
      reports().filter((r) => r.execution === "incomplete" && !r.acceptance && r.active_artifact)
        .length,
      1,
    );
    e.pull_request.base.sha = head;
    writeFileSync(file, JSON.stringify(e));
    await runMaintenancePolicy("check", cwd);
    assert.equal(
      reports().filter((r) => r.execution === "no-introduced-artifacts" && !r.acceptance).length,
      1,
    );
    const marker = "credential-marker-must-not-leak";
    const documents = parseAllDocuments(readFileSync(path.join(cwd, "pnpm-lock.yaml"), "utf8")).map(
      (d) => {
        const value: unknown = d.toJS();
        return fixtureRecord(value);
      },
    );
    const url = `https://user:${marker}@example.invalid/archive.tgz`;
    const importer = fixtureRecord(fixtureRecord(fixtureRecord(documents[1]).importers)["."]);
    const dependencies =
      importer.dependencies === undefined ? {} : fixtureRecord(importer.dependencies);
    importer.dependencies = dependencies;
    dependencies.private = { specifier: url, version: url };
    writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      documents.map((d) => stringify(d)).join("---\n"),
    );
    git("add", "pnpm-lock.yaml");
    git("commit", "-m", "unsupported source fixture");
    e.pull_request.head.sha = git("rev-parse", "HEAD");
    e.pull_request.base.sha = base;
    writeFileSync(file, JSON.stringify(e));
    await assert.rejects(runMaintenancePolicy("check", cwd), (error: Error) => {
      assert.match(error.message, /unsupported pnpm source/);
      assert.ok(!error.message.includes(marker));
      return true;
    });
    assert.ok(!JSON.stringify(reports()).includes(marker));
    e.pull_request.body = "ambiguous";
    writeFileSync(file, JSON.stringify(e));
    await assert.rejects(runMaintenancePolicy("classify", cwd), /ambiguous/);
    assert.equal(
      reports().filter(
        (r) =>
          r.execution === "incomplete" &&
          !r.acceptance &&
          typeof r.failure === "string" &&
          /ambiguous/.test(r.failure),
      ).length,
      1,
    );
  } finally {
    for (const key of variables) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});
function lockData(integrity: string, version = "1.0.0") {
  const dependencies: Record<string, unknown> = {
    alias: { specifier: "npm:shape@1.0.0", version: `shape@${version}` },
  };
  const packages: Record<string, { resolution: Record<string, unknown> }> = {
    [`shape@${version}`]: { resolution: { integrity } },
  };
  const snapshots: Record<string, Record<string, unknown>> = { [`shape@${version}`]: {} };
  return { lockfileVersion: "9.0", importers: { ".": { dependencies } }, packages, snapshots };
}
function lock(integrity: string, version = "1.0.0") {
  return stringify(lockData(integrity, version));
}

void test("all pnpm documents bind alias/peer contexts and reject hidden integrity/source gaps", () => {
  const sri = artifact("npm").integrity;
  const first = lock(sri),
    second = lock(`sha512-${Buffer.alloc(64).toString("base64")}`);
  assert.throws(() => lockInventory(`${first}---\n${second}`), /Conflicting/);
  assert.equal(registrySnapshotCoverage(`${first}---\n${first}`).documents, 2);
  assert.throws(
    () =>
      registrySnapshotCoverage(
        first.replace("version: shape@1.0.0", "version: git+https://evil.invalid"),
      ),
    /unsupported/,
  );
  assert.throws(
    () => registrySnapshotCoverage(first.replace("snapshots:", "unused:")),
    /Incomplete/,
  );
  const actual = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.equal(registrySnapshotCoverage(actual).documents, 2);
});
void test("unchanged non-registry references remain explicit, changed references cannot gain coverage", () => {
  for (const version of [
    "link:../local",
    "workspace:*",
    "file:../local.tgz",
    "git+https://example.invalid/repo#abc",
    "https://example.invalid/archive.tgz",
  ]) {
    const document = lockData(artifact("npm").integrity);
    document.importers["."].dependencies.local = { specifier: version, version };
    requiredFixture(document.snapshots["shape@1.0.0"]).optionalDependencies = { local: version };
    const original = stringify(document);
    const coverage = registrySnapshotCoverage(original, original);
    assert.equal(coverage.unchangedUnsupported.length, 2);
    assert.throws(() => registrySnapshotCoverage(original), /unsupported/);
    fixtureRecord(document.importers["."].dependencies.local).version = `${version}-changed`;
    assert.throws(() => registrySnapshotCoverage(stringify(document), original), /unsupported/);
  }
  const base = lock(artifact("npm").integrity);
  const custom = lockData(artifact("npm").integrity);
  requiredFixture(custom.packages["shape@1.0.0"]).resolution.tarball =
    "https://example.invalid/custom.tgz";
  const retained = stringify(custom);
  assert.equal(registrySnapshotCoverage(retained, retained).unchangedUnsupported.length, 3);
  assert.throws(() => registrySnapshotCoverage(retained, base), /unsupported/);
  assert.ok(introducedPackages(base, retained).some((p) => p.unsupported !== undefined));
  const marker = "credential-marker-must-not-leak";
  const malicious = lockData(artifact("npm").integrity);
  malicious.importers["."].dependencies.private = {
    version: `https://user:${marker}@example.invalid/archive`,
  };
  assert.throws(
    () => registrySnapshotCoverage(stringify(malicious)),
    (error: Error) => {
      assert.ok(!error.message.includes(marker));
      assert.match(error.message, /sha256/);
      return true;
    },
  );
});
