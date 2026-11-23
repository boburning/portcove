import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseBatoceraPackage,
  parseLuxtorpedaIndex,
  parseMacSourcePortsMeta,
  parseRecompLauncherCatalog,
  parseRetropieModule,
} from "./discovery-distribution-parsers.mts";
import { DiscoverySession } from "./daily-discovery-session.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { externalListIds, externalHintSummary } from "./discovery-external-lists.mts";
import { parseLeadState } from "./discovery-leads.mts";
import { fixtureGitHub } from "./fixtures/github-sdk-fixtures.mts";

// Shapes observed live on 2026-11-23; identities are anonymized.
void test("Luxtorpeda keeps native engines and their games, and excludes fallbacks", () => {
  const parsed = parseLuxtorpedaIndex(
    JSON.stringify({
      default_engine: {},
      engines: [
        {
          engine_name: "UZDoom",
          internal_engine_name: "gzdoom",
          engine_link: "https://github.com/UZDoom/UZDoom",
          version: "f49e8bc",
          notices: [{ key: "in_progress" }],
        },
        {
          engine_name: "Arx Libertatis",
          internal_engine_name: "arxlibertatis",
          engine_link: "https://arx-libertatis.org/",
          version: "1.2.1",
        },
        {
          engine_name: "ScummVM",
          internal_engine_name: "scummvm",
          engine_link: "https://github.com/scummvm/scummvm",
        },
        {
          engine_name: "DOSBox Staging",
          internal_engine_name: "dosbox-staging",
          engine_link: "https://github.com/dosbox-staging/dosbox-staging",
        },
        {
          engine_name: "Godot",
          internal_engine_name: "godot",
          engine_link: "https://github.com/godotengine/godot",
        },
        {
          engine_name: "Widescreen Fixes",
          internal_engine_name: "WidescreenFixesPack",
          engine_link: "https://github.com/ThirteenAG/WidescreenFixesPack",
          notices: [{ key: "uses_proton" }],
        },
      ],
      games: [
        { app_id: "2280", game_name: "Ultimate Doom", engine_name: "UZDoom" },
        {
          app_id: "2300",
          game_name: "Doom II",
          choices: [{ name: "UZDoom", engine_name: "UZDoom" }],
        },
        { app_id: "1700", game_name: "Arx Fatalis", engine_name: "Arx Libertatis" },
      ],
    }),
  );
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.key, entry.host]),
    [
      ["https://arx-libertatis.org", "web"],
      ["https://github.com/uzdoom/uzdoom", "github"],
    ],
  );
  assert.equal(parsed.excluded, 4, "ScummVM, an emulator, a runtime and a Proton-only fix");
  const engine = parsed.entries[1]!.source_entries![0]!;
  assert.equal(engine.relation, "distribution");
  assert.equal(engine.channel, "luxtorpeda");
  assert.equal(engine.pinned, "f49e8bc");
  assert.deepEqual(engine.games, ["steam:2280 Ultimate Doom", "steam:2300 Doom II"]);
  assert.equal(engine.status, "in_progress");
  assert.throws(() => parseLuxtorpedaIndex(JSON.stringify({ engines: {} })), /Unsupported/u);
});

void test("Mac Source Ports keeps each build as a distribution of its upstream", () => {
  const parsed = parseMacSourcePortsMeta(
    JSON.stringify([
      {
        sourcePortStub: "dhewm3",
        sourcePortTitle: "dhewm3",
        sourcePortType: "Universal 2",
        buildVersion: "1.5.5",
        sourcePortGitHub: "https://github.com/dhewm/dhewm3",
        MSPBuild: true,
        MSPGitHub: "https://github.com/MacSourcePorts/dhewm3",
      },
      {
        sourcePortStub: "0ad",
        sourcePortTitle: "0 A.D.",
        sourcePortType: "Apple Silicon",
        buildVersion: "0.28.0",
        sourcePortGitHub: "https://gitea.wildfiregames.com/0ad/0ad",
      },
      { sourcePortStub: "nolink", sourcePortTitle: "No link", sourcePortType: "Intel 64-bit" },
    ]),
  );
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.key, entry.source_entries![0]!.status]),
    [
      ["https://gitea.wildfiregames.com/0ad/0ad", "upstream-build"],
      ["https://github.com/dhewm/dhewm3", "separately-built"],
    ],
    "Mac Source Ports' own fork is never an upstream",
  );
  assert.deepEqual(parsed.entries[1]!.source_entries![0]!.targets, ["macOS Universal 2"]);
  assert.equal(parsed.unlinked, 1);
});

void test("Batocera and RetroPie definitions are read as text with their pins attributed", () => {
  const batocera = parseBatoceraPackage(
    [
      "DHEWM3_VERSION = 1.5.5",
      "DHEWM3_SITE = $(call github,dhewm,dhewm3,$(DHEWM3_VERSION))",
      "DEVILUTIONX_VERSION = 0123456789abcdef0123456789abcdef01234567",
      "DEVILUTIONX_SITE = \\",
      "  https://github.com/diasurgical/devilutionX.git",
      "OTHER_SITE = $(OTHER_BASE)/x",
    ].join("\n"),
    "package/batocera/ports/dhewm3/dhewm3.mk",
  );
  assert.deepEqual(
    batocera.entries.map((entry) => [entry.key, entry.source_entries![0]!.pinned]),
    [
      ["https://github.com/dhewm/dhewm3", "1.5.5"],
      ["https://github.com/diasurgical/devilutionx", "0123456789abcdef0123456789abcdef01234567"],
    ],
  );
  assert.equal(batocera.entries[0]!.source_entries![0]!.channel, "batocera");

  const retropie = parseRetropieModule(
    [
      'rp_module_id="cannonball"',
      'rp_module_desc="Cannonball - An Enhanced OutRun Engine"',
      'rp_module_section="exp"',
      'rp_module_repo="git https://github.com/djyt/cannonball.git master 2b3839dd34c1b4263ec5006fdeeb1ae2689cd401"',
      "function sources_cannonball() {",
      "  gitPullOrClone",
      '  gitPullOrClone "$md_build/zmusic" https://github.com/ZDoom/ZMusic',
      "}",
    ].join("\n"),
    "scriptmodules/ports/cannonball.sh",
  );
  assert.deepEqual(
    retropie.entries.map((entry) => [entry.key, entry.source_entries![0]!.pinned]),
    [
      ["https://github.com/djyt/cannonball", "2b3839dd34c1b4263ec5006fdeeb1ae2689cd401"],
      ["https://github.com/zdoom/zmusic", null],
    ],
  );
  const resolvedAtInstall = parseRetropieModule(
    'rp_module_id="gzdoom"\nrp_module_repo="git https://github.com/ZDoom/gzdoom :_get_version_gzdoom"',
    "scriptmodules/ports/gzdoom.sh",
  );
  assert.equal(
    resolvedAtInstall.entries[0]!.source_entries![0]!.pinned,
    null,
    "a pin a shell function resolves at install time is not static",
  );
  const packaged = parseRetropieModule(
    'rp_module_id="openttd"\naptInstall openttd',
    "x/openttd.sh",
  );
  assert.equal(packaged.unlinked, 1);
});

void test("RecompLauncher keeps each app, its host and its newer-launcher groups", () => {
  const parsed = parseRecompLauncherCatalog(
    JSON.stringify({
      catalogVersion: 1,
      platform: "pc",
      apps: [
        {
          id: "zelda64recomp",
          name: "Zelda 64: Recompiled",
          game: "Majora's Mask",
          origin: "n64",
          repo: "Zelda64Recomp/Zelda64Recomp",
          tag: "v1.2.2",
          systems: ["windows", "linux", "macos"],
        },
        {
          id: "engage",
          name: "Engage",
          game: "Engage",
          origin: "switch",
          repo: "engage/engage-pc",
          host: "gitlab",
        },
        { id: "bundle", name: "Bundle", games: ["A", "B"], repo: "owner/bundle", status: "paused" },
      ],
      apps_min: [
        {
          min: "0.90.0",
          apps: [
            {
              id: "hookshot",
              name: "Hookshot",
              game: "Ocarina",
              repo: "git.example.dev/Hookshot/Hookshot",
              host: "forgejo",
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.key, entry.host]),
    [
      ["https://git.example.dev/hookshot/hookshot", "web"],
      ["https://github.com/owner/bundle", "github"],
      ["https://github.com/zelda64recomp/zelda64recomp", "github"],
      ["https://gitlab.com/engage/engage-pc", "gitlab"],
    ],
  );
  const bundle = parsed.entries[1]!.source_entries![0]!;
  assert.deepEqual(bundle.games, ["A", "B"]);
  assert.equal(bundle.status, "paused");
  assert.equal(parsed.entries[2]!.source_entries![0]!.latest_release, "v1.2.2");
  assert.throws(
    () => parseRecompLauncherCatalog(JSON.stringify({ catalogVersion: 2, apps: [] })),
    /Unsupported/u,
  );
});

void test("a repository-directory baseline reads only changed definitions at an exact revision", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-directory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let revision = "a".repeat(40);
  let blob = "blob-1";
  const raw: string[] = [];
  const listings: string[] = [];
  const session = Object.create(DiscoverySession.prototype) as DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  const leads = parseLeadState(undefined);
  const now = "2026-11-23T17:00:00.000Z";
  const setAttempts = (at: string) => {
    leads.external ??= { lists: {}, hints: {} };
    leads.external.attempts = Object.fromEntries(
      externalListIds
        .filter((id) => id !== "retropie-ports")
        .map((id) => [id, { attempted_at: at, outcome: "partial" as const }]),
    );
  };
  setAttempts(now);
  Object.assign(session, {
    stateDir: root,
    runDir: root,
    journalFile: path.join(root, "journal.json"),
    checkpoint: {},
    checkpointPreimage: "fixture",
    inventory: { issues: [] },
    intakeRecords: [],
    journal: { format: 1, started_at: now, notes: [], candidates: {}, evidence: {} },
    leads,
    budget,
    leadPages: 0,
    searches: 0,
    leadCollectionAttempted: true,
    researchedLeads: new Set<number>(),
    unattended: true,
  });
  session.knownLeadUrls = () => new Set();
  const sdk = await fixtureGitHub(({ endpoint }) => {
    if (endpoint === "repos/RetroPie/RetroPie-Setup")
      return { id: 41, full_name: "RetroPie/RetroPie-Setup", default_branch: "master" };
    if (endpoint === "repos/RetroPie/RetroPie-Setup/git/ref/heads/master")
      return { object: { sha: revision } };
    if (endpoint.startsWith("repos/RetroPie/RetroPie-Setup/contents/scriptmodules/ports")) {
      listings.push(endpoint);
      return [
        { type: "file", path: "scriptmodules/ports/cannonball.sh", sha: blob },
        { type: "file", path: "scriptmodules/ports/opentyrian.sh", sha: "blob-2" },
        { type: "file", path: "scriptmodules/ports/README.md", sha: "doc" },
      ];
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  Object.defineProperty(session, "source", {
    configurable: true,
    value: {
      budget,
      sdk,
      http: {
        request: async (_method: string, url: string) => {
          raw.push(url);
          const name = url.split("/").at(-1)!.replace(/\.sh$/u, "");
          return {
            requests: 1,
            bytes: 100,
            status: 200,
            headers: {},
            text: `rp_module_id="${name}"\nrp_module_repo="git https://github.com/owner/${name}.git master"`,
          };
        },
      },
    },
  });
  await session.collectExternalLists();
  assert.deepEqual(
    raw.map((url) => url.replace(`/${revision}/`, "/REV/")),
    [
      "https://raw.githubusercontent.com/RetroPie/RetroPie-Setup/REV/scriptmodules/ports/cannonball.sh",
      "https://raw.githubusercontent.com/RetroPie/RetroPie-Setup/REV/scriptmodules/ports/opentyrian.sh",
    ],
  );
  const external = session.leads.external!;
  assert.ok(external.hints["https://github.com/owner/cannonball"]);
  assert.equal(external.lists["retropie-ports"]?.entries, 2);
  assert.equal(external.inventories?.["retropie-ports"]?.repository_id, 41);
  const summary = externalHintSummary(external, new Set(), new Map(), now);
  assert.equal(summary.inventories["retropie-ports"]?.read, 2);

  // The next day only the changed file at the new revision is read.
  const next = "2026-11-24T17:00:00.000Z";
  revision = "b".repeat(40);
  blob = "blob-1-changed";
  raw.length = 0;
  setAttempts(next);
  session.leads.external!.attempts = leads.external!.attempts ?? {};
  session.externalCollectionAttempted = false;
  Object.assign(session, { journal: { ...session.journal, started_at: next, notes: [] } });
  await session.collectExternalLists();
  assert.deepEqual(raw, [
    `https://raw.githubusercontent.com/RetroPie/RetroPie-Setup/${revision}/scriptmodules/ports/cannonball.sh`,
  ]);
  assert.equal(listings.length, 2);
});

void test("distribution extraction keeps variable sites, real pins and recognized hosts only", () => {
  const batocera = parseBatoceraPackage(
    [
      "  DEVILUTIONX_VERSION = 1.5.4",
      "  DEVILUTIONX_SITE = https://github.com/diasurgical/devilutionX/releases/download/$(DEVILUTIONX_VERSION)",
      "EDUKE32_SITE = https://voidpoint.io/terminx/eduke32/-/archive/$(EDUKE32_VERSION)",
    ].join("\n"),
    "package/batocera/ports/devilutionx/devilutionx.mk",
  );
  assert.deepEqual(
    batocera.entries.map((entry) => entry.key),
    ["https://github.com/diasurgical/devilutionx", "https://voidpoint.io/terminx/eduke32"],
    "a download route built from make variables still names its project",
  );
  const branch = parseRetropieModule(
    'rp_module_id="dxx"\nrp_module_repo="git https://github.com/dxx-rebirth/dxx-rebirth master :_get_commit"',
    "x/dxx.sh",
  );
  assert.equal(branch.entries[0]!.source_entries![0]!.pinned, null, "a branch is not a pin");
  const quoted = parseRetropieModule(
    "rp_module_id='q'\nrp_module_repo='git https://github.com/a/b.git main 0123abc'\ngitPullOrClone \"$d\" https://github.com/c/d.git;",
    "x/q.sh",
  );
  assert.deepEqual(
    quoted.entries.map((entry) => [entry.key, entry.source_entries![0]!.pinned]),
    [
      ["https://github.com/a/b", "0123abc"],
      ["https://github.com/c/d", null],
    ],
  );
  const hosts = parseRecompLauncherCatalog(
    JSON.stringify({
      catalogVersion: 1,
      apps: [
        { id: "a", repo: "owner/name", host: "codeberg" },
        { id: "b", repo: "git.example.dev/owner/name" },
        { id: "c", repo: "project", host: "sourceforge" },
      ],
    }),
  );
  assert.deepEqual(
    hosts.entries.map((entry) => entry.key),
    ["https://sourceforge.net/projects/project"],
    "an unnamed host or a dotted value is never mapped to GitHub",
  );
  assert.equal(hosts.unlinked, 2);
  const forks = parseMacSourcePortsMeta(
    JSON.stringify([
      {
        sourcePortStub: "x",
        sourcePortType: "Universal 2",
        sourcePortGitHub: "https://github.com/MacSourcePorts/disasteroids3d",
      },
    ]),
  );
  assert.equal(forks.entries.length, 0);
  assert.equal(forks.excluded, 1);
});
