import {
  assertPreparedInputParent,
  settingsQualificationCatalog,
} from "./prepare-settings-candidate.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import test from "node:test";
import {
  checkSettingsPolicy,
  qualifySettingsObservation,
  projectSettingsQualification,
  settingsSourceRegion,
  collectSettingsSource,
} from "./settings-qualification.mts";
import { projectAuthoredPort, checkedAuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import type { SettingsQualificationPolicy } from "./settings-qualification.mts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
test("prepared data can use the retained root or a descendant but cannot escape", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "portcove-prepared-parent-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(await realpath(base), "retained");
  const nested = join(root, "nested");
  await mkdir(nested, { recursive: true });
  const retained = toNamespacedPath(root);
  await assertPreparedInputParent(retained, join(retained, "oot.o2r"));
  await assertPreparedInputParent(retained, join(retained, "nested", "oot.o2r"));
  await assert.rejects(
    assertPreparedInputParent(retained, join(base, "outside.o2r")),
    /escaped its retained root/,
  );
});

function fixture() {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL("../crates/portcove-core/catalog/ports/shipwright.json", import.meta.url),
      "utf8",
    ),
  );
  const record: AuthoredPort = checkedAuthoredPort(parsed);
  const content = "unrelated before\nBEGIN\naccepted exact settings code\nEND\nunrelated after";
  const roles = ["consumer", "loader", "storage", "path", "build"] as const;
  const policy: SettingsQualificationPolicy = {
    format_version: 1,
    regions: roles.map((role) => ({
      role,
      repository: "HarbourMasters/Shipwright",
      path: `${role}.cpp`,
      start: "BEGIN",
      end: "END",
      sha256: hash("BEGIN\naccepted exact settings code\n"),
    })),
    samples: [
      {
        file_id: "preferences",
        document:
          '{"CVars":{"gSettings":{"Volume":{"Master":37,"Unrelated":73}}},"keep":{"unknown":[true,3]}}',
      },
    ],
  };
  record.settings_qualification_v1 = policy;
  const binding = {
    version: "next-release",
    platform: "windows-x86-64" as const,
    archive_sha256: "a".repeat(64),
    source_commit: "b".repeat(40),
  };
  const files = policy.regions.map((region) => ({
    repository: region.repository,
    revision: binding.source_commit,
    path: region.path,
    content,
  }));
  // Synthetic accepted-input fixture only; no actual native execution is claimed.
  const receipt = {
    id: record.listing.id,
    source_revision: binding.source_commit,
    expected_digest_matched: true,
    observed_archive_sha256: binding.archive_sha256,
    official_asset: { digest: `sha256:${binding.archive_sha256}` },
    selected_executables: [{ sha256: "d".repeat(64) }],
    settings_consumer: {
      archive_sha256: binding.archive_sha256,
      source_commit: binding.source_commit,
      client_sha256: "c".repeat(64),
      executable_sha256: "d".repeat(64),
      evidence_sha256: "e".repeat(64),
      observations: [
        {
          file_id: "preferences",
          setting_id: "master-volume",
          requested_values: [40, 0, 100],
          observed_values: [40, 0, 100],
        },
      ],
    },
  };
  const inspect = (input: Buffer) => {
    const parsed: unknown = JSON.parse(input.toString());
    assert.ok(isRecord(parsed));
    return {
      format_version: 1,
      input_sha256: hash(input),
      binding: parsed.candidate,
      validator_artifact_sha256: "c".repeat(64),
      checks: [
        {
          file_id: "preferences",
          setting_id: "master-volume",
          values_tested: 3,
          values: [40, 0, 100],
        },
      ],
    };
  };
  return { record, policy, binding, files, receipt, inspect };
}

void test("qualification generates a new exact binding without editing the authored settings or old installation", async () => {
  const { record, binding, files, receipt, inspect } = fixture();
  const original = structuredClone(record);
  const observation = await qualifySettingsObservation(record, binding, receipt, files, inspect);
  assert.deepEqual(record, original);
  const prepared = { ...record, settings_observation_v1: observation };
  const projected = projectAuthoredPort(prepared)!;
  const settings = projected.game_settings as { releases: unknown[] };
  assert.equal(settings.releases.length, 2);
  assert.deepEqual(settings.releases[1], observation.binding);
  assert.deepEqual(record, original);
  assert.deepEqual(
    projectAuthoredPort(original)!.game_settings,
    original.integration!.game_settings,
  );
});

void test("unrelated source churn is ignored but settings contract changes and insufficient evidence refuse", async () => {
  const { record, binding, files, receipt, inspect } = fixture();
  const unrelated = files.map((file) => ({
    ...file,
    content: file.content.replace("unrelated before", "changed unrelated implementation"),
  }));
  await qualifySettingsObservation(record, binding, receipt, unrelated, inspect);
  const changed = files.map((file, index) =>
    index ? file : { ...file, content: file.content.replace("accepted exact", "changed") },
  );
  await assert.rejects(
    qualifySettingsObservation(record, binding, receipt, changed, inspect),
    /consumer contract changed/,
  );
  await assert.rejects(
    qualifySettingsObservation(record, binding, receipt, files.slice(1), inspect),
    /missing, ambiguous/,
  );
  await assert.rejects(
    qualifySettingsObservation(
      record,
      binding,
      { ...receipt, expected_digest_matched: false },
      files,
      inspect,
    ),
    /independently expected/,
  );
  await assert.rejects(
    qualifySettingsObservation(record, binding, receipt, files, (input) => ({
      ...inspect(input),
      checks: [],
    })),
    /incomplete/,
  );
  await assert.rejects(
    qualifySettingsObservation(record, binding, receipt, files, (input) => ({
      ...inspect(input),
      input_sha256: "0".repeat(64),
    })),
    /different inputs/,
  );
  await assert.rejects(
    qualifySettingsObservation(
      record,
      binding,
      { ...receipt, settings_consumer: undefined },
      files,
      inspect,
    ),
    /native consumer evidence/,
  );
});

void test("generated binding cannot follow expanded keys or paths and cannot replace historical exact identity", async () => {
  const { record, binding, files, receipt, inspect } = fixture();
  const observation = await qualifySettingsObservation(record, binding, receipt, files, inspect);
  const expanded = structuredClone({ ...record, settings_observation_v1: observation });
  const settings = expanded.integration!.game_settings as { files: { path: string }[] };
  settings.files[0]!.path = "other.json";
  assert.throws(() => projectSettingsQualification(expanded), /no longer matches/);
  const conflict = structuredClone({ ...record, settings_observation_v1: observation });
  const contract = conflict.integration!.game_settings as { releases: unknown[] };
  contract.releases.push({ ...observation.binding, archive_sha256: "d".repeat(64) });
  assert.throws(() => projectSettingsQualification(conflict), /historical binding/);
  assert.deepEqual(
    projectSettingsQualification(record),
    record,
    "unqualified package receives no generated permission",
  );
});

void test("every replayed projection revalidates probe input, complete checks, consumer values and root revision", async () => {
  const { record, binding, files, receipt, inspect } = fixture();
  const observation = await qualifySettingsObservation(record, binding, receipt, files, inspect);
  for (const change of [
    (value: typeof observation) => {
      value.probe.checks = [];
    },
    (value: typeof observation) => {
      value.probe.input_sha256 = "f".repeat(64);
    },
    (value: typeof observation) => {
      value.consumer_probe.observations = [];
    },
    (value: typeof observation) => {
      (value.consumer_probe.observations as { observed_values: number[] }[])[0]!.observed_values = [
        40, 0, 99,
      ];
    },
    (value: typeof observation) => {
      value.source_regions[0]!.revision = "f".repeat(40);
    },
  ]) {
    const changed = structuredClone(observation);
    change(changed);
    assert.throws(
      () => projectSettingsQualification({ ...record, settings_observation_v1: changed }),
      /incomplete|evidence|no longer matches/,
    );
  }
});

void test("source region discovery rejects ambiguous, absent and unsafe policy identities", () => {
  const { policy, files } = fixture();
  assert.throws(
    () => settingsSourceRegion(files[0]!.content + "\nBEGIN again", policy.regions[0]!),
    /missing, ambiguous/,
  );
  assert.throws(() => settingsSourceRegion("no match", policy.regions[0]!), /missing, ambiguous/);
  const unsafe = structuredClone(policy);
  unsafe.regions[0]!.path = "../config.cpp";
  assert.throws(() => checkSettingsPolicy(unsafe), /Invalid settings source/);
  const incomplete = structuredClone(policy);
  incomplete.regions[4]!.role = "consumer";
  assert.throws(() => checkSettingsPolicy(incomplete), /lacks/);
});

void test("source collection binds public provider identity, release tag and immutable blob bytes through the shared client", async () => {
  const { record, binding, files } = fixture();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.github.com");
    requests.push(url.pathname);
    let body: unknown;
    if (url.pathname === "/repos/HarbourMasters/Shipwright")
      body = { private: false, full_name: "HarbourMasters/Shipwright" };
    else if (url.pathname.includes("/commits/")) body = { sha: binding.source_commit };
    else {
      assert.equal(url.searchParams.get("ref"), binding.source_commit);
      const file = files.find((file) => url.pathname.endsWith("/" + file.path));
      assert.ok(file);
      const bytes = Buffer.from(file.content);
      body = {
        type: "file",
        encoding: "base64",
        content: bytes.toString("base64"),
        size: bytes.length,
        sha: createHash("sha1")
          .update("blob " + bytes.length + "\0")
          .update(bytes)
          .digest("hex"),
      };
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const observed = await collectSettingsSource(record, binding.source_commit, {
    fetcher,
    token: "synthetic-token",
    releaseTag: binding.version,
  });
  assert.deepEqual(observed, files);
  assert.equal(requests.length, 7);
  await assert.rejects(
    collectSettingsSource(record, "f".repeat(40), { fetcher, releaseTag: binding.version }),
    /differs from the selected release tag/,
  );
});

void test("private repository and changed submodule origins refuse before source-content collection", async () => {
  const { record, binding } = fixture();
  const requests: string[] = [];
  const privateFetcher: typeof fetch = async (input) => {
    requests.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return new Response(JSON.stringify({ private: true, full_name: "HarbourMasters/Shipwright" }), {
      headers: { "content-type": "application/json" },
    });
  };
  await assert.rejects(
    collectSettingsSource(record, binding.source_commit, {
      fetcher: privateFetcher,
      releaseTag: binding.version,
    }),
    /public upstream repository/,
  );
  assert.equal(requests.length, 1);
  const submodule = structuredClone(record);
  submodule.settings_qualification_v1!.regions[0]!.submodule_path = "libultraship";
  submodule.settings_qualification_v1!.regions[0]!.repository = "kenix3/libultraship";
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    assert.equal(url.origin, "https://api.github.com");
    let body: unknown;
    if (!url.pathname.includes("/contents/") && !url.pathname.includes("/commits/"))
      body = { private: false, full_name: url.pathname.slice("/repos/".length) };
    else if (url.pathname.includes("/commits/")) body = { sha: binding.source_commit };
    else body = { sha: "f".repeat(40), submodule_git_url: "https://untrusted.example/engine.git" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    collectSettingsSource(submodule, binding.source_commit, {
      fetcher,
      releaseTag: binding.version,
    }),
    /submodule source identity differs/,
  );
});

void test("disposable candidate projection never borrows a historical authored release binding", () => {
  const { record, binding } = fixture();
  const original = projectAuthoredPort(record)!;
  const catalog = { ports: [original, { id: "unrelated", explicit: true }] };
  const before = structuredClone(catalog);
  const generated = settingsQualificationCatalog(catalog, record.listing.id, binding);
  assert.deepEqual(catalog, before);
  const ports: unknown[] = generated.ports as unknown[];
  assert.ok(isRecord(ports[0]) && isRecord(ports[0].game_settings));
  assert.deepEqual(ports[0].game_settings.releases, [binding]);
  assert.deepEqual(ports[1], before.ports[1]);
  assert.throws(() => settingsQualificationCatalog(catalog, "missing", binding), /absent/u);
});
