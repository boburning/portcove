import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");

test("schema-2 migration is deterministic and preserves the frozen schema-1 projection", () => {
  const result = spawnSync(process.execPath, ["scripts/migrate-catalog-schema2.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const legacy = JSON.parse(
    readFileSync(join(catalogRoot, "catalog-schema1-fixture.json"), "utf8"),
  );
  const migrated = JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8"));
  assert.equal(migrated.schema_version, 2);
  assert.equal("source_profiles" in migrated, false);
  assert.equal(migrated.source_catalog.identities.length, legacy.source_profiles.length + 6);
  assert.equal(migrated.ports.length, legacy.ports.length + 6);
  assert.equal(
    migrated.source_catalog.contracts.length,
    legacy.ports.reduce(
      (count, port) =>
        count + Number(Boolean(port.source_profile)) + Number(Boolean(port.bios_source_profile)),
      0,
    ) + 6,
  );

  const profile = (id) => migrated.source_catalog.identities.find((item) => item.id === id);
  const contract = (portId) =>
    migrated.source_catalog.contracts.find(
      (item) => item.port_id === portId && item.role === "game",
    );
  assert.deepEqual(
    profile("ghostship-source")
      .variants.slice(1)
      .map((item) => item.id),
    ["super-mario-64-us", "super-mario-64-jp"],
  );
  assert.deepEqual(contract("lighthouse").supported_variant_ids, [
    "usa-rev0",
    "usa-rev1",
    "pal-rev0",
    "japan-rev0",
  ]);
  assert.deepEqual(contract("starship").supported_variant_ids, ["usa-1-0", "usa-1-1"]);
  for (const portId of [
    "ghostship",
    "lighthouse",
    "banjo-recomp",
    "shipwright",
    "2ship2harkinian",
    "zelda64-recomp",
    "starship",
  ]) {
    assert.equal(contract(portId).supported_variant_ids.includes("legacy-accepted"), false);
  }
  assert.deepEqual(contract("snap64-recomp").supported_variant_ids, ["usa-rev0"]);
  assert.equal(profile("pokemon-snap").variants[0].representations[0].kind, "canonical-n64");
  assert.deepEqual(contract("cvlod-recomp").supported_variant_ids, ["north-america"]);
  assert.equal(
    profile("castlevania-legacy-of-darkness").variants[0].representations[0].kind,
    "canonical-n64",
  );
  assert.deepEqual(contract("diddy-kong-racing-golden-balloon").supported_variant_ids, [
    "usa-rev1",
    "europe-rev1",
  ]);
  assert.deepEqual(
    profile("diddy-kong-racing-golden-balloon").variants.map((item) => item.id),
    ["usa-rev1", "europe-rev1"],
  );
  const goldenBalloon = migrated.ports.find(
    (port) => port.id === "diddy-kong-racing-golden-balloon",
  );
  assert.deepEqual(goldenBalloon.platforms, ["windows-x86-64"]);
  assert.equal(goldenBalloon.runtime_subdirectory, "GoldenBalloon");
  assert.deepEqual(goldenBalloon.runtime_mutable_paths, [
    "mdkr64.log",
    "mdkr64.prev.log",
    "mdkr64-online-failure.txt",
  ]);
  assert.deepEqual(
    goldenBalloon.runtime_mutable_paths.map(
      (relative) => `${goldenBalloon.runtime_subdirectory}/${relative}`,
    ),
    [
      "GoldenBalloon/mdkr64.log",
      "GoldenBalloon/mdkr64.prev.log",
      "GoldenBalloon/mdkr64-online-failure.txt",
    ],
  );
  assert.equal(goldenBalloon.launch_environment.MDKR_APP_PREFS_DIR, ".");
  assert.deepEqual(goldenBalloon.launch_arguments, ["--rom", "dkr-v80.z64"]);
  assert.deepEqual(contract("star-fox-enhanced").supported_variant_ids, ["usa-v1-0"]);
  const starFoxProfile = profile("star-fox-enhanced-usa-v1-0");
  assert.deepEqual(
    starFoxProfile.variants.map((item) => item.id),
    ["usa-v1-0"],
  );
  assert.deepEqual(starFoxProfile.variants[0].representations[0].identities, [
    {
      scope: "normalized-content",
      sha1: "1f5355534ccfaf26ae6c8f055f3e4768f9d72a7e",
      sha256: "3857b5294ea8f7468849437bb2d8271564e8a0ff30774622e9c872bcbd53a84d",
      crc32: null,
    },
  ]);
  const starFoxEnhanced = migrated.ports.find((port) => port.id === "star-fox-enhanced");
  assert.deepEqual(starFoxEnhanced.platforms, ["windows-x86-64"]);
  assert.deepEqual(starFoxEnhanced.channels, ["beta"]);
  assert.equal(starFoxEnhanced.adapter, "staged-source-portable");
  assert.deepEqual(starFoxEnhanced.release.asset_hints["windows-x86-64"], [
    "StarFoxEnhanced-",
    "windows-x64.zip",
  ]);
  assert.equal(starFoxEnhanced.runtime_source_filename, undefined);
  assert.equal(starFoxEnhanced.runtime_source_materialization, undefined);
  assert.equal(starFoxEnhanced.source_environment, "STARFOX_RETAIL_ROM");
  assert.deepEqual(starFoxEnhanced.runtime_mutable_paths, ["Starfox-Assets.BIN.tmp"]);
  assert.deepEqual(starFoxEnhanced.persistent_paths, [
    "Starfox-Assets.BIN",
    "starfox-ex.srm",
    "pregame.cfg",
    "input-bindings.cfg",
    "hud-layout.cfg",
    "states",
    "Starfox-MSU1.PAK",
  ]);
  const dnzhProfile = profile("duke-nukem-zero-hour");
  assert.deepEqual(
    dnzhProfile.variants.map((item) => item.id),
    ["usa"],
  );
  assert.deepEqual(dnzhProfile.variants[0].representations[0].identities, [
    {
      scope: "canonical-n64-big-endian",
      sha1: "de4db292cc6cf5dd1dd1d3c9700cf8e5c3078410",
      sha256: "5ba016567c53b0d111eb175347c6eee603c31783cd2bb3fea97f31b5ff74190f",
      crc32: null,
    },
  ]);
  const dnzhContract = contract("duke-nukem-zero-hour-recompiled");
  assert.deepEqual(dnzhContract.supported_variant_ids, ["usa"]);
  assert.deepEqual(dnzhContract.applicability, [
    {
      upstream_ref: "0.0.3",
      artifact_sha256: "ece88320327ffc58ec73e084c23aca274a016e45dd3558a684d59c37f88bdbc3",
    },
  ]);
  const dnzh = migrated.ports.find((port) => port.id === "duke-nukem-zero-hour-recompiled");
  assert.equal(dnzh.release.provider, "gitlab");
  assert.equal(dnzh.release.repository, "sonicdcer/DNZHRecomp");
  assert.equal("version" in dnzh.release, false);
  assert.deepEqual(dnzh.channels, ["stable"]);
  assert.deepEqual(dnzh.release.asset_hints["windows-x86-64"], ["windows-relwithdebinfo"]);
  assert.equal(dnzh.adapter, "n64-recomp-portable");
  assert.equal(dnzh.portable_marker, true);
  assert.equal(dnzh.runtime_source_filename, "dnzh.us.z64");
  assert.equal(dnzh.runtime_source_materialization, "n64-big-endian");
  assert.equal(dnzh.persistent_paths.includes("saves"), true);
  assert.equal(dnzh.persistent_paths.includes("mod_config"), true);
  const apeEscapeProfile = profile("ape-escape-psx");
  assert.deepEqual(
    apeEscapeProfile.variants.map((item) => item.id),
    ["usa-rev0"],
  );
  assert.deepEqual(apeEscapeProfile.variants[0].representations[0].identities, [
    {
      scope: "psx-normalized-track-set",
      sha1: "466cce4bcd6992f57227abd270323bcdad2fb7fc",
      sha256: "1ae17e78ebb8c782c7c1785b0a0bd7b0ee28235b8a0c83c8df887129899a852a",
      crc32: null,
    },
  ]);
  const apeEscapeContract = contract("ape-escape-recompiled");
  assert.deepEqual(apeEscapeContract.supported_variant_ids, ["usa-rev0"]);
  assert.deepEqual(apeEscapeContract.applicability, [
    {
      upstream_ref: "v0.3.0",
      artifact_sha256: "91e2cde5f16408ff51b4b822ebba8b811c4e591263170cb49f33a486606c58e9",
    },
  ]);
  const apeEscape = migrated.ports.find((port) => port.id === "ape-escape-recompiled");
  assert.equal(apeEscape.adapter, "staged-source-portable");
  assert.equal(apeEscape.runtime_source_materialization, "psx-bin-cue");
  assert.deepEqual(apeEscape.persistent_paths, [
    "saves",
    "settings.toml",
    "input.ini",
    "keybinds.ini",
    "disc.cfg",
    "bios.cfg",
    "mods",
  ]);
  assert.deepEqual(apeEscape.runtime_mutable_paths, [
    "cache",
    "disc",
    "overlay_captures.json",
    "overlay_captures.json.d",
    "psx_freeze_heartbeat.json",
    "psx_last_run_report.json",
  ]);
  assert.deepEqual(apeEscape.runtime_mutable_file_patterns, [
    {
      prefix: "psx_freeze_dump_psx-runtime_",
      suffix: ".json",
    },
  ]);
  assert.equal(
    migrated.source_catalog.qualification.some(
      (record) => record.scope.port_id === "ape-escape-recompiled",
    ),
    false,
  );
  const drMarioProfile = profile("dr-mario-64");
  assert.deepEqual(
    drMarioProfile.variants.slice(1).map((item) => item.id),
    ["usa-rev0"],
  );
  assert.equal(drMarioProfile.variants[1].representations[0].kind, "canonical-n64");
  assert.deepEqual(drMarioProfile.variants[1].representations[0].identities, [
    {
      scope: "canonical-n64-big-endian",
      sha1: "a130d3622ce40e0158db2da4247101f6e92206fc",
      sha256: "bb2c0dec0a8287ad256929563d0509801c2f239df883c1cf52cab05b23bd77b6",
      crc32: null,
    },
  ]);
  const drMarioContract = contract("dr-mario-64-recomp");
  assert.equal(drMarioContract.admission_mode, "enforced");
  assert.deepEqual(drMarioContract.supported_variant_ids, ["usa-rev0"]);
  assert.deepEqual(drMarioContract.applicability, [
    {
      upstream_ref: "1.0.0",
      artifact_sha256: "ba749f48725e23636845c9a79a89e17859172ac80fa7b98bf4523d12c1f0d2cf",
    },
  ]);
  const drMario = migrated.ports.find((port) => port.id === "dr-mario-64-recomp");
  assert.equal(drMario.project_url, "https://github.com/theboy181/drmario64_recomp_plus");
  assert.equal(drMario.support_tier, "beta");
  assert.equal(drMario.release.repository, "theboy181/drmario64_recomp_plus");
  assert.deepEqual(drMario.release.asset_hints["windows-x86-64"], [
    "Dr.Mario.64.Recompiled-",
    "-Windows.zip",
  ]);
  for (const [id, hint] of Object.entries({
    "zelda64-recomp": "Linux-X64.zip",
    "banjo-recomp": "Linux-X64.",
    "bm64-recomp": "Linux-X64-Release",
    "harvest-moon-64-recomp": "Linux-X64.zip",
    "bomberman-hero-recomp": "Linux-X64-Release",
    "trouble-makers-recomp": "TroubleMakers-x86_64.AppImage",
    "goemon64-recomp": "Linux-X64",
  })) {
    const port = migrated.ports.find((candidate) => candidate.id === id);
    assert.deepEqual(port.release.asset_hints["linux-x86-64"], [hint]);
  }
  assert.deepEqual(drMario.executable_hints["windows-x86-64"], ["drmario64_recomp.exe"]);
  assert.equal(drMario.runtime_subdirectory, "Dr. Mario 64 Recompiled x64-Release");
  assert.equal(drMario.runtime_source_filename, "drmario64.us.z64");
  assert.equal(drMario.runtime_source_materialization, "n64-big-endian");
  assert.deepEqual(drMario.runtime_source_hashes, {
    "drmario64.us.z64": "bb2c0dec0a8287ad256929563d0509801c2f239df883c1cf52cab05b23bd77b6",
  });
  assert.deepEqual(drMario.launch_arguments, ["drmario64.us.z64"]);
  assert.equal(
    drMario.persistent_paths.includes("Dr. Mario 64 Recompiled x64-Release/mod_config"),
    true,
  );
  assert.equal(drMario.presentation.source_requirements[0].verification, "catalog-identity");
  assert.equal(migrated.source_catalog.qualification.length, 14);
  const ygofmQualification = migrated.source_catalog.qualification.filter(
    (record) => record.scope.port_id === "yu-gi-oh-forbidden-memories-recompiled",
  );
  assert.deepEqual(
    ygofmQualification.map((record) => [record.kind, record.outcome]),
    [
      ["structural_check", "passed"],
      ["automated_lifecycle", "passed"],
      ["automated_lifecycle", "passed"],
    ],
  );
  assert.equal(
    ygofmQualification.every(
      (record) =>
        record.scope.artifact_sha256 ===
          "4eed315000952dee7a751a05de4413a88777cf49609d29ab77ee3765a44d0f53" &&
        record.scope.upstream_ref === "v0.6.1" &&
        record.scope.check_version === "ygofm-windows-qualification-v1",
    ),
    true,
  );
  const ygofmAutomated = ygofmQualification.filter(
    (record) => record.kind === "automated_lifecycle",
  );
  assert.deepEqual(
    ygofmAutomated.map((record) => record.portcove_commit),
    ["327626b154a45f2af52de77ab06fae54c4794ef2", "6bf60b6e0f24a1eef7a7efcfdb181a6cc2692cef"],
  );
  assert.equal(
    ygofmAutomated[0].evidence_ids.includes(
      "yu-gi-oh-forbidden-memories-recompiled-windows-2026-09-15",
    ),
    true,
  );
  assert.equal(
    ygofmAutomated[1].evidence_ids.includes(
      "yu-gi-oh-forbidden-memories-recompiled-windows-cross-version-2026-09-15",
    ),
    true,
  );
  assert.match(ygofmAutomated[1].method, /v0\.5\.7-to-v0\.6\.1 update/);
  assert.match(ygofmAutomated[1].method, /retained-version reactivation/);
  assert.deepEqual(contract("yu-gi-oh-forbidden-memories-recompiled").applicability, [
    {
      upstream_ref: "v0.6.1",
      artifact_sha256: "4eed315000952dee7a751a05de4413a88777cf49609d29ab77ee3765a44d0f53",
    },
  ]);
  assert.equal(
    contract("yu-gi-oh-forbidden-memories-recompiled").evidence_ids.includes(
      "yu-gi-oh-forbidden-memories-recompiled-windows-2026-09-15",
    ),
    true,
  );
  const personaQualification = migrated.source_catalog.qualification.filter(
    (record) => record.scope.port_id === "revelations-persona-recompiled",
  );
  assert.deepEqual(
    personaQualification.map((record) => [record.kind, record.outcome]),
    [
      ["structural_check", "passed"],
      ["automated_lifecycle", "passed"],
      ["automated_lifecycle", "passed"],
    ],
  );
  assert.equal(
    personaQualification.every(
      (record) =>
        record.scope.artifact_sha256 ===
          "f4336030ba9c0e032061ad6892aa5ce9ff01c4cedcbaf3a5355428e6d728158a" &&
        record.scope.upstream_ref === "v0.1.1" &&
        record.scope.check_version === "persona-windows-qualification-v1",
    ),
    true,
  );
  assert.deepEqual(
    personaQualification.map((record) => record.evidence_ids),
    [
      ["revelations-persona-recompiled-windows-2026-09-15"],
      ["revelations-persona-recompiled-windows-2026-09-15"],
      ["revelations-persona-recompiled-windows-reinstall-2026-09-15"],
    ],
  );
  assert.match(personaQualification[2].method, /managed removal/);
  assert.match(personaQualification[2].method, /clean reinstall with a new identity/);
  assert.match(personaQualification[2].method, /generated runtime-copy restoration/);
  assert.deepEqual(contract("revelations-persona-recompiled").applicability, [
    {
      upstream_ref: "v0.1.1",
      artifact_sha256: "f4336030ba9c0e032061ad6892aa5ce9ff01c4cedcbaf3a5355428e6d728158a",
    },
  ]);
  assert.equal(
    contract("revelations-persona-recompiled").evidence_ids.includes(
      "revelations-persona-recompiled-windows-2026-09-15",
    ),
    true,
  );
  assert.equal(
    contract("revelations-persona-recompiled").evidence_ids.includes(
      "revelations-persona-recompiled-windows-reinstall-2026-09-15",
    ),
    true,
  );
  const dnzhQualification = migrated.source_catalog.qualification.filter(
    (record) => record.scope.port_id === "duke-nukem-zero-hour-recompiled",
  );
  assert.deepEqual(
    dnzhQualification.map((record) => [record.kind, record.outcome]),
    [
      ["structural_check", "passed"],
      ["automated_lifecycle", "passed"],
    ],
  );
  assert.equal(
    dnzhQualification.every(
      (record) =>
        record.scope.artifact_sha256 ===
          "ece88320327ffc58ec73e084c23aca274a016e45dd3558a684d59c37f88bdbc3" &&
        record.scope.upstream_ref === "0.0.3" &&
        record.scope.contract_id === "duke-nukem-zero-hour-recompiled-game-source" &&
        record.scope.variant.identity.game_id === "duke-nukem-zero-hour" &&
        record.scope.variant.identity.variant_id === "usa" &&
        record.scope.variant.identity.representation_id === "canonical-rom" &&
        record.scope.check_version === "dnzh-windows-qualification-v1" &&
        record.portcove_commit === "73702601fa3f24c5b47f7aff43e228c75c4370ba" &&
        record.evidence_ids.includes("duke-nukem-zero-hour-windows-lifecycle-2026-09-16"),
    ),
    true,
  );
  assert.match(dnzhQualification[1].method, /live GitLab resolution/);
  assert.match(dnzhQualification[1].method, /adopted-to-downloaded update/);
  assert.match(dnzhQualification[1].method, /removal, reinstall/);
  assert.equal(
    contract("duke-nukem-zero-hour-recompiled").evidence_ids.includes(
      "duke-nukem-zero-hour-windows-lifecycle-2026-09-16",
    ),
    true,
  );
  assert.equal(
    contract("duke-nukem-zero-hour-recompiled").authority_ref,
    "73702601fa3f24c5b47f7aff43e228c75c4370ba",
  );
  const drMarioQualification = migrated.source_catalog.qualification.filter(
    (record) => record.scope.port_id === "dr-mario-64-recomp",
  );
  assert.deepEqual(
    drMarioQualification.map((record) => [record.kind, record.outcome]),
    [
      ["structural_check", "passed"],
      ["automated_lifecycle", "passed"],
      ["known_failure", "failed"],
    ],
  );
  assert.equal(
    drMarioQualification.every(
      (record) =>
        record.scope.artifact_sha256 ===
          "ba749f48725e23636845c9a79a89e17859172ac80fa7b98bf4523d12c1f0d2cf" &&
        record.scope.upstream_ref === "1.0.0" &&
        record.scope.contract_id === "dr-mario-64-recomp-game-source" &&
        record.scope.variant.identity.game_id === "dr-mario-64" &&
        record.scope.variant.identity.variant_id === "usa-rev0" &&
        record.scope.variant.identity.representation_id === "canonical-rom" &&
        record.scope.check_version === "dr-mario-windows-qualification-v1" &&
        record.evidence_ids.includes("dr-mario-64-recompiled-windows-2026-09-15"),
    ),
    true,
  );
});
