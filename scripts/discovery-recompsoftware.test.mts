import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoverySession as Session } from "./daily-discovery-session.mts";
import {
  parseRecompSoftwareCatalog,
  bindExternalListSource,
  mergeExternalList,
  parseExternalLeadState,
  recordExternalListFailure,
  selectExternalResolutions,
} from "./discovery-external-lists.mts";
import {
  parseLeadState,
  retainLeadResults,
  linkExternalHints,
  pendingLeads,
} from "./discovery-leads.mts";
const at = "2026-11-17T12:00:00Z";
const entry = (slug: string, extra = {}) => ({
  slug,
  name: slug,
  subject: slug,
  category: "games",
  method: "matching-decomp",
  status: "released",
  targets: ["Linux"],
  needsOriginal: true,
  latestRelease: null,
  repo: "https://github.com/sourcehold/OpenSHC",
  ...extra,
});
const parse = (rows: unknown[]) => parseRecompSoftwareCatalog(JSON.stringify(rows));
void test("source entries preserve game associations while shared repositories are read once", () => {
  const parsed = parse([entry("stronghold"), entry("crusader")]);
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(
    parsed.entries[0]!.source_entries?.map((v) => v.id),
    ["crusader", "stronghold"],
  );
  assert.equal("supported" in parsed.entries[0]!, false);
  assert.equal(
    "playable" in parsed.entries[0]!,
    false,
    "released reports are never playable evidence",
  );
  const revision = "e981757f31fdb58b85e546069cf303daac56cc61";
  const url = `https://raw.githubusercontent.com/andrewnakas/recompsoftware/${revision}/data/projects/games.json`;
  assert.equal(bindExternalListSource(parsed, "[]", url, revision).source?.revision, revision);
  assert.throws(() => bindExternalListSource(parsed, "[]", url, "main"));
  assert.throws(() => parse([entry("same"), entry("same")]));
  assert.throws(() => parseRecompSoftwareCatalog("["));
});
void test("canonical snapshot replay is quiet, changes enter primary research and failure retains last good", () => {
  const key = "https://github.com/sourcehold/openshc";
  const first = mergeExternalList(
    undefined,
    "recompsoftware",
    parse([entry("stronghold")]),
    at,
    "pinned.json",
  );
  assert.deepEqual(selectExternalResolutions(first, new Set([key]), new Map(), at), []);
  assert.deepEqual(
    mergeExternalList(first, "recompsoftware", parse([entry("stronghold")]), at, "pinned.json"),
    first,
  );
  const changed = mergeExternalList(
    first,
    "recompsoftware",
    parse([entry("stronghold", { targets: ["Linux", "Windows"] })]),
    at,
    "next.json",
  );
  assert.equal(selectExternalResolutions(changed, new Set([key]), new Map(), at).length, 1);
  let state = retainLeadResults(
    parseLeadState(undefined),
    [
      {
        id: 42,
        full_name: "sourcehold/OpenSHC",
        html_url: "https://github.com/sourcehold/OpenSHC",
        description: "reverse engineering reports",
      },
    ],
    at,
    "primary.json",
  );
  state.records["42"]!.status = "canonical";
  state = linkExternalHints({ ...state, external: changed }, at);
  assert.equal(
    pendingLeads(state, new Set([key])).length,
    1,
    "known URL must not suppress changed route research",
  );
  assert.equal(
    state.records["42"]!.external_change?.fingerprint,
    changed.hints[key]?.source_change?.fingerprint,
  );
  const failed = recordExternalListFailure(state.external, "recompsoftware", at, "unavailable");
  assert.deepEqual(failed.hints, state.external!.hints);
  assert.deepEqual(failed.lists, state.external!.lists);
  assert.deepEqual(parseExternalLeadState(failed), failed);
  const absent = mergeExternalList(
    failed,
    "recompsoftware",
    parse([entry("unrelated", { repo: "https://github.com/other/project" })]),
    at,
    "partial.json",
  );
  assert.ok(absent.hints[key], "absence never means upstream deletion");
});

void test("scheduled collection compares the consumed baseline before handing changed canonical claims to primary research", async (t) => {
  const { DiscoverySession } = await import("./daily-discovery-session.mts");
  const { DiscoveryBudget } = await import("./discovery-budget.mts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os"),
    path = await import("node:path");
  const root = mkdtempSync(path.join(os.tmpdir(), "recomp-collection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = Object.create(DiscoverySession.prototype) as Session;
  const leads = parseLeadState(undefined);
  leads.external = {
    lists: {},
    hints: {},
    attempts: Object.fromEntries(
      [
        "decomp-buddy-finds",
        "portsdr",
        "alexbeav-psx",
        "decomp-fun",
        "unbaked-additions",
        "portmaster",
        "osgc",
      ].map((id) => [id, { attempted_at: at, outcome: "partial" as const }]),
    ),
  };
  const budget = new DiscoveryBudget("ordinary");
  Object.assign(session, {
    stateDir: root,
    runDir: root,
    journalFile: path.join(root, "journal.json"),
    checkpoint: {},
    checkpointPreimage: "fixture",
    inventory: { issues: [] },
    intakeRecords: [],
    journal: { format: 1, started_at: at, notes: [], candidates: {}, evidence: {} },
    leads,
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: true,
    researchedLeads: new Set<number>(),
  });
  session.knownLeadUrls = () => new Set(["https://github.com/sourcehold/openshc"]);
  const revision = "b".repeat(40),
    urls: string[] = [],
    endpoints: string[] = [];
  Object.defineProperty(session, "source", {
    value: {
      budget,
      http: {
        request: async (_method: string, url: string) => {
          urls.push(url);
          return {
            status: 200,
            text: JSON.stringify([
              entry("stronghold", url.includes(revision) ? { targets: ["Linux", "Windows"] } : {}),
            ]),
            headers: {},
            requests: 1,
            bytes: 100,
          };
        },
      },
      sdk: {
        request: async (request: { url: string }) => {
          endpoints.push(request.url);
          return {
            data: request.url.endsWith("/repos/andrewnakas/recompsoftware")
              ? {
                  id: 1418451069,
                  full_name: "andrewnakas/recompsoftware",
                  default_branch: "releases/current",
                }
              : request.url.endsWith("/git/ref/heads/releases%2Fcurrent")
                ? { object: { sha: revision } }
                : request.url.endsWith("/git/ref/heads/main") ||
                    request.url.endsWith("/commits/main")
                  ? { object: { sha: "a".repeat(40) }, sha: "a".repeat(40) }
                  : {
                      id: 42,
                      full_name: "sourcehold/OpenSHC",
                      html_url: "https://github.com/sourcehold/OpenSHC",
                      description: "reverse engineering reports",
                    },
          };
        },
      },
    },
  });
  await session.collectExternalLists();
  assert.equal(
    urls.length,
    2,
    "newer bootstrap reads current and the already reviewed immutable baseline",
  );
  assert.ok(urls.every((url) => !url.includes("/main/")));
  assert.ok(endpoints.some((url) => url.endsWith("/git/ref/heads/releases%2Fcurrent")));
  assert.ok(endpoints.every((url) => !url.endsWith("/main")));
  assert.equal(
    endpoints.filter((url) => url.endsWith("/sourcehold/openshc")).length,
    1,
    "changed canonical source gets one primary identity read",
  );
  assert.equal(
    pendingLeads(session.leads, new Set(["https://github.com/sourcehold/openshc"])).length,
    1,
  );
  assert.equal(session.leads.external?.lists.recompsoftware?.source?.revision, revision);
  await session.collectExternalLists();
  assert.equal(
    urls.length,
    2,
    "the same run cannot repeat source collection or create duplicate work",
  );
});
