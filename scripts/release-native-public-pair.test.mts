import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  inspectInitialPublicJourneyCohort,
  acquireActualPublicJourneyPair,
  requireActualPublicJourneyPair,
  requireActualPublicJourneyPackage,
} from "./release-native-public-pair.mts";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const files = new Map<string, Buffer>(),
    entries: Record<string, unknown>[] = [];
  const allocations = [0, 1].map((i) => ({
    version: `0.1.${i}`,
    source_commit: String(i + 1).repeat(40),
    source_tree: "9".repeat(40),
    prepared_commit: String(i + 3).repeat(40),
    prepared_tree: String(i + 5).repeat(40),
    intent_sha256: String(i + 7).repeat(64),
  }));
  const add = (value: Record<string, unknown>, entry: Record<string, unknown>) => {
    const bytes = Buffer.from(JSON.stringify(value));
    files.set(`records/${String(entry.path)}`, bytes);
    entries.push({ ...entry, bytes: bytes.length, sha256: sha(bytes) });
    return sha(bytes);
  };
  for (const allocation of allocations) {
    const releasePath = `releases/${allocation.version}/windows-x86_64/nsis.json`;
    const hash = add(
      {
        schema_version: 1,
        version: allocation.version,
        source_commit: allocation.prepared_commit,
        source_tree: allocation.prepared_tree,
        target: "windows-x86_64",
        qualified_run: {
          workflow: ".github/workflows/release.yml",
          workflow_commit: allocation.prepared_commit,
          run_id: 111 + Number(allocation.version.at(-1)),
          attempt: 1,
          inventory_sha256: "a".repeat(64),
        },
        artifact: {
          url: `https://github.com/boburning/portcove/releases/download/v${allocation.version}/Portcove_${allocation.version}_x64-setup.exe`,
          bytes: 1024,
          sha256: allocation.intent_sha256,
          tauri_signature: "inert-signature-not-authenticated",
          payload_key_id: "b".repeat(64),
        },
      },
      {
        kind: "release",
        path: releasePath,
        version: allocation.version,
        target: "windows-x86_64",
        package: "nsis",
      },
    );
    add(
      {
        schema_version: 1,
        version: allocation.version,
        eligible: true,
        withdrawn: false,
        required_bridge: null,
        release_path: releasePath,
        release_sha256: hash,
      },
      {
        kind: "promotion",
        channel: "preview",
        version: allocation.version,
        target: "windows-x86_64",
        package: "nsis",
        path: `channels/preview/windows-x86_64/nsis/${allocation.version}.json`,
      },
    );
  }
  files.set(
    "records/reconstruction-manifest.json",
    Buffer.from(JSON.stringify({ schema_version: 1, records: entries })),
  );
  return { files, allocations, entries };
}
void test("initial public pair associates first allocations with exact retained records/current Preview, without appointing native authority", () => {
  const f = fixture(),
    pair = inspectInitialPublicJourneyCohort(f.allocations, f.files, "windows-x86_64");
  assert.equal(pair.prior.version, "0.1.0");
  assert.equal(pair.candidate.version, "0.1.1");
  assert.equal(pair.authority, "none");
  assert.equal(pair.candidate.source_commit, f.allocations[1]!.prepared_commit);
  f.allocations[1]!.prepared_tree = "c".repeat(40);
  assert.throws(() => inspectInitialPublicJourneyCohort(f.allocations, f.files, "windows-x86_64"));
});
void test("missing prior, changed bytes, duplicate allocations and another current Preview refuse", () => {
  {
    const f = fixture();
    assert.throws(() =>
      inspectInitialPublicJourneyCohort(f.allocations.slice(1), f.files, "windows-x86_64"),
    );
  }
  {
    const f = fixture();
    f.files.set("records/releases/0.1.0/windows-x86_64/nsis.json", Buffer.from("{}"));
    assert.throws(() =>
      inspectInitialPublicJourneyCohort(f.allocations, f.files, "windows-x86_64"),
    );
  }
  {
    const f = fixture();
    assert.throws(() =>
      inspectInitialPublicJourneyCohort(
        [f.allocations[0]!, f.allocations[0]!],
        f.files,
        "windows-x86_64",
      ),
    );
  }
  {
    const f = fixture();
    const entry = f.entries.find((item) => item.kind === "promotion" && item.version === "0.1.1")!;
    const bytes = f.files.get(`records/${String(entry.path)}`)!;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    assert.ok(isRecord(value));
    value.eligible = false;
    const changed = Buffer.from(JSON.stringify(value));
    f.files.set(`records/${String(entry.path)}`, changed);
    entry.bytes = changed.length;
    entry.sha256 = sha(changed);
    f.files.set(
      "records/reconstruction-manifest.json",
      Buffer.from(JSON.stringify({ schema_version: 1, records: f.entries })),
    );
    assert.throws(() =>
      inspectInitialPublicJourneyCohort(f.allocations, f.files, "windows-x86_64"),
    );
  }
});
void test("raw pair/setup imports cannot enter actual parent or public custody factories", async () => {
  await assert.rejects(
    acquireActualPublicJourneyPair({
      public_journey: { profile: "ordinary-public-initial-cohort-v1" },
    }),
    /actual installed native parent provenance/,
  );
  await assert.rejects(
    requireActualPublicJourneyPair(
      inspectInitialPublicJourneyCohort(fixture().allocations, fixture().files, "windows-x86_64"),
    ),
    /actual parent\/public Tough pair/,
  );
  await assert.rejects(
    requireActualPublicJourneyPackage({ kind: "actual-public-journey-package", authority: "none" }),
    /actual public immutable package custody/,
  );
});
