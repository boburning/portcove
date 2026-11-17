import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { secondaryPanelFixtures } from "./desktop-secondary-panels-fixture.mts";
import { transportValue } from "./transport-values.mts";
import {
  installSecondaryPanelProbe,
  type SecondaryPanelProbeCleanup,
  type SecondaryPanelProbeObservation,
  type SecondaryPanelProbeOptions,
} from "./desktop-secondary-panels-probe.mts";

const root = "C:/owned-native-output";
const options: SecondaryPanelProbeOptions = {
  generation: 7,
  fixtures: secondaryPanelFixtures("owned-installed-port", root, "owned-installed-runtime"),
  recipePath: `${root}/recipe.json`,
  portableInputPath: `${root}/incoming.json`,
  portableOutputPath: `${root}/outgoing.json`,
  metadataPath: `${root}/metadata.json`,
  refusedMetadataPath: `${root}/metadata-refused.json`,
};

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function responseObject(response: Response) {
  const value: unknown = await response.json();
  return object(value);
}

void test("supplied panel replies satisfy their existing Rust transport schemas", async (context) => {
  const fixtures = options.fixtures;
  for (const [contract, value] of [
    ["mod_setups_view", fixtures.mods],
    ["profile_original_review", fixtures.original],
    ["retained_build_retirement_preview", fixtures.retirement],
    [
      "retained_build_resolution",
      {
        availability: "verified",
        gap: null,
        install: null,
        reference: fixtures.retirement.reference,
        history: fixtures.recovery,
      },
    ],
    ["mod_file_preservation_plan", fixtures.preservation],
    ["recipe_import_plan", fixtures.recipe],
    ["provider_browse_page", fixtures.providerPage],
    ["provider_project_view", fixtures.providerProject],
    ["provider_install_plan", fixtures.providerPlan],
    ["portable_save_export_preview", fixtures.portableExport],
    ["portable_save_import_preview", fixtures.portableImport],
    ["desktop_port_intent_assessments", fixtures.ready],
  ] as const)
    await context.test(contract, () => {
      transportValue(contract, value);
    });
});

function installed() {
  const forwarded: { input: unknown; init: unknown }[] = [];
  const original: typeof fetch = (input, init) => {
    forwarded.push({ input, init });
    return Promise.resolve(new Response(JSON.stringify({ core: "owned original transport" })));
  };
  const window = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: (command: string, protocol: string) => {
        assert.equal(protocol, "ipc");
        return `https://owned-ipc.invalid/${command}`;
      },
    },
    __portcoveSecondaryPanelProbe: undefined as
      | {
          phase(value: "mods" | "preservation"): void;
          capture(): SecondaryPanelProbeObservation;
          restore(): SecondaryPanelProbeCleanup;
        }
      | undefined,
  };
  const serialized: unknown = runInNewContext(`(${installSecondaryPanelProbe.toString()})`, {
    window,
    Response,
    URL,
  });
  assert.ok(typeof serialized === "function");
  const install = (value: SecondaryPanelProbeOptions) => {
    Reflect.apply(serialized, undefined, [value]);
  };
  install(structuredClone(options));
  const probe = window.__portcoveSecondaryPanelProbe;
  assert.ok(probe);
  const call = (command: string, args: Record<string, unknown> = {}) =>
    window.fetch(`https://owned-ipc.invalid/${command}`, {
      body: JSON.stringify({ portId: options.fixtures.portId, generation: 7, ...args }),
    });
  return { window, original, forwarded, probe, call, install };
}

void test("serialized native panel probe supplies fixed views and preserves unrelated transport", async () => {
  const { window, original, forwarded, probe, call } = installed();
  const view = await responseObject(await call("get_mod_setups"));
  assert.equal(view.port_id, options.fixtures.portId);
  assert.deepEqual(object(view.live).unmanaged, []);
  probe.phase("preservation");
  const preservation = await responseObject(await call("get_mod_setups"));
  assert.deepEqual(object(preservation.live).unmanaged, [options.fixtures.modName]);
  assert.deepEqual(options.fixtures.mods.live.unmanaged, []);
  const external = new URL("https://unrelated.invalid/art.png");
  const init = { headers: { "X-Owned-Test": "value" } };
  const response = await window.fetch(external, init);
  assert.deepEqual(await response.json(), { core: "owned original transport" });
  assert.equal(forwarded[0]?.input, external);
  assert.equal(forwarded[0]?.init, init);
  await call("get_workspace_snapshot");
  assert.equal(forwarded.length, 2);
  const cleanup = probe.restore();
  assert.equal(cleanup.restored, true);
  assert.equal(cleanup.trustworthy, true);
  assert.equal(window.fetch, original);
  assert.equal(window.__portcoveSecondaryPanelProbe, undefined);
});

void test("every declared secondary mutation is refused without reaching Core", async () => {
  const { call, forwarded, probe } = installed();
  const originalTarget = {
    profileId: options.fixtures.setupId,
    expectedRevision: 2,
    requirementId: "owned-original",
  };
  const requests: [string, Record<string, unknown>][] = [
    ["select_mod_setup_original", { ...originalTarget, instanceId: "owned-original-alternative" }],
    [
      "relink_mod_setup_original",
      { ...originalTarget, path: options.fixtures.original.instances[0]!.path },
    ],
    [
      "preserve_mod_file",
      { fileName: options.fixtures.modName, expectedPlan: options.fixtures.sha },
    ],
    [
      "retire_mod_setup_recovery_build",
      {
        profileId: options.fixtures.setupId,
        revision: 1,
        expectedPreviewSha256: options.fixtures.sha,
      },
    ],
    [
      "acquire_mod_recipe_package",
      {
        profileId: options.fixtures.setupId,
        nativeId: options.fixtures.modName,
        plan: options.fixtures.recipe,
      },
    ],
    [
      "apply_mod_recipe",
      { displayName: "Owned presentation copy", plan: options.fixtures.recipe, allowCode: false },
    ],
    [
      "apply_provider_install",
      {
        profileId: options.fixtures.setupId,
        expectedPlanSha256: options.fixtures.sha,
        plan: options.fixtures.providerPlan,
        allowCode: false,
      },
    ],
    [
      "export_portable_saves",
      { path: options.portableOutputPath, expectedContent: options.fixtures.sha },
    ],
    [
      "import_portable_saves",
      {
        path: options.portableInputPath,
        removeLocalOnlySaves: false,
        replaceDivergedProgress: false,
        expectedPreview: options.fixtures.sha,
      },
    ],
  ];
  for (const [command, args] of requests) {
    const response = await call(command, args);
    assert.equal(response.headers.get("Tauri-Response"), "error", command);
    const message = (await responseObject(response)).message;
    assert.ok(typeof message === "string");
    assert.match(message, /Owned presentation fixture refused/u);
  }
  assert.deepEqual(forwarded, []);
  assert.equal(probe.capture().trace.length, 9);
  assert.equal(probe.restore().trustworthy, true);
});

void test("unplanned controls in a supplied mod panel fail the observation before Core", async () => {
  const { call, forwarded, probe } = installed();
  for (const command of [
    "create_default_mod_setup",
    "copy_mod_setup",
    "create_clean_mod_setup",
    "list_mod_setup_revisions",
    "plan_profile_recovery",
    "apply_profile_recovery",
    "use_mod_setup",
    "export_mod_recipe",
    "set_mod_package_enabled",
    "remove_mod_package",
    "set_mod_update_policy",
    "check_provider_mod_updates",
    "open_provider_mod_project",
    "plan_local_mod_package",
    "apply_local_mod_package",
  ])
    assert.equal((await call(command)).headers.get("Tauri-Response"), "error", command);
  assert.deepEqual(forwarded, []);
  const cleanup = probe.restore();
  assert.equal(cleanup.mismatches.length, 15);
  assert.equal(cleanup.trustworthy, false);
});

void test("acknowledgement refusal and success stay in the supplied notice fixture", async () => {
  const { call, forwarded, probe } = installed();
  const args = {
    acknowledgements: [{ port_id: options.fixtures.portId, plan_sha256: options.fixtures.sha }],
  };
  assert.equal(
    (await call("acknowledge_port_readiness", args)).headers.get("Tauri-Response"),
    "error",
  );
  assert.equal(probe.capture().acknowledged, false);
  assert.equal(
    (await call("acknowledge_port_readiness", args)).headers.get("Tauri-Response"),
    "ok",
  );
  assert.equal(probe.capture().acknowledged, true);
  assert.deepEqual((await responseObject(await call("assess_port_intents"))).assessments, []);
  assert.deepEqual(forwarded, []);
  assert.equal(probe.restore().trustworthy, true);
});

void test("only the exact owned successful metadata path reaches Core", async () => {
  const { call, forwarded, probe } = installed();
  const accepted = await call("export_library_metadata", { path: options.metadataPath });
  assert.deepEqual(await accepted.json(), { core: "owned original transport" });
  const refused = await call("export_library_metadata", { path: options.refusedMetadataPath });
  assert.equal(refused.headers.get("Tauri-Response"), "error");
  assert.equal(forwarded.length, 1);
  const mismatch = await call("export_library_metadata", { path: "C:/outside-player-data.json" });
  assert.equal(mismatch.headers.get("Tauri-Response"), "error");
  assert.equal(forwarded.length, 1);
  assert.equal(probe.restore().trustworthy, false);
});

void test("changed identity and malformed targeted requests fail visibly and preserve bounded trace fields", async () => {
  const { window, call, forwarded, probe } = installed();
  for (const args of [
    { portId: "another-port" },
    { generation: 8 },
    { profileId: "another-setup" },
    { onEvent: "__CHANNEL__:123" },
  ]) {
    const response = await call("preserve_mod_file", {
      ...args,
      secret: "must-not-enter-evidence",
    });
    assert.equal(response.headers.get("Tauri-Response"), "error");
  }
  const malformed = await window.fetch("https://owned-ipc.invalid/get_mod_setups", {
    body: "{broken",
  });
  assert.equal(malformed.headers.get("Tauri-Response"), "error");
  assert.deepEqual(forwarded, []);
  const cleanup = probe.restore();
  assert.equal(cleanup.restored, true);
  assert.equal(cleanup.trustworthy, false);
  assert.equal(cleanup.mismatches.length, 5);
  assert.doesNotMatch(JSON.stringify(cleanup), /must-not-enter-evidence/u);
});

void test("restoration preserves a later fetch owner and rejects duplicate installation", () => {
  const { window, original, probe, install } = installed();
  assert.throws(() => install(structuredClone(options)), /already installed/u);
  const foreign: typeof fetch = () => Promise.resolve(new Response("foreign"));
  window.fetch = foreign;
  const cleanup = probe.restore();
  assert.equal(cleanup.restored, false);
  assert.equal(cleanup.trustworthy, false);
  assert.equal(window.fetch, foreign);
  assert.notEqual(window.fetch, original);
});

void test("the finite trace bound refuses further targets and records incomplete observation", async () => {
  const { call, forwarded, probe } = installed();
  for (let index = 0; index < 512; index++) await call("get_mod_setups");
  assert.equal((await call("get_mod_setups")).headers.get("Tauri-Response"), "error");
  const cleanup = probe.restore();
  assert.equal(cleanup.trace.length, 512);
  assert.equal(cleanup.mismatches.length, 1);
  assert.equal(cleanup.trustworthy, false);
  assert.deepEqual(forwarded, []);
});
