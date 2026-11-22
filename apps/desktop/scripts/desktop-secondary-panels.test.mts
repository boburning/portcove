import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { secondaryPanelFixtures } from "./desktop-secondary-panels-fixture.mts";
import { secondaryPanelsScenario } from "./desktop-secondary-panels-test.mts";
import { isUntrustworthyProbeError } from "./desktop-owned-ipc-probe.mts";
import { transportValue } from "./transport-values.mts";
import {
  installSecondaryPanelProbe,
  type SecondaryPanelProbeCleanup,
  type SecondaryPanelProbeObservation,
  type SecondaryPanelProbeOptions,
} from "./desktop-secondary-panels-probe.mts";

afterEach(() => {
  vi.restoreAllMocks();
});

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

const fixtures = options.fixtures;
const schemaCases = [
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
  ["desktop_recipe_import_review", fixtures.recipe],
  ["provider_browse_page", fixtures.providerPage],
  ["provider_project_view", fixtures.providerProject],
  ["provider_install_plan", fixtures.providerPlan],
  ["portable_save_export_preview", fixtures.portableExport],
  ["portable_save_import_preview", fixtures.portableImport],
  ["desktop_port_intent_assessments", fixtures.ready],
] as const;
test.each(schemaCases)(
  "supplied %s replies satisfy their Rust transport schema",
  (contract, value) => {
    assert.doesNotThrow(() => transportValue(contract, value));
  },
);

function installed(probeOptions = options) {
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
  install(structuredClone(probeOptions));
  const probe = window.__portcoveSecondaryPanelProbe;
  assert.ok(probe);
  const call = (command: string, args: Record<string, unknown> = {}) =>
    window.fetch(`https://owned-ipc.invalid/${command}`, {
      body: JSON.stringify({ portId: options.fixtures.portId, generation: 7, ...args }),
    });
  return { window, original, forwarded, probe, call, install };
}

test("serialized native panel probe supplies fixed views and preserves unrelated transport", async () => {
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

test("every declared secondary mutation is refused without reaching Core", async () => {
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
        serializedPlan: options.fixtures.recipe.serialized_plan,
      },
    ],
    [
      "apply_mod_recipe",
      {
        displayName: "Owned presentation copy",
        serializedPlan: options.fixtures.recipe.serialized_plan,
        allowCode: false,
      },
    ],
    [
      "apply_mod_setup_draft",
      {
        profileId: options.fixtures.setupId,
        expectedRevision: 2,
        plans: [options.fixtures.providerPlan],
        edits: { packages: [], order: null, local_files: [] },
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

test("unplanned controls in a supplied mod panel fail the observation before Core", async () => {
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

test("acknowledgement refusal and success stay in the supplied notice fixture", async () => {
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

test("only the exact owned successful metadata path reaches Core", async () => {
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

test("Windows metadata picker aliases still bind the complete owned file path", async () => {
  const { call, forwarded, probe } = installed({ ...options, windowsPickerPaths: true });
  const accepted = await call("export_library_metadata", {
    path: String.raw`\\?\c:\owned-native-output\metadata.json`,
  });
  assert.deepEqual(await accepted.json(), { core: "owned original transport" });
  const refused = await call("export_library_metadata", {
    path: String.raw`C:\owned-native-output\metadata-refused.json`,
  });
  assert.equal(
    (await responseObject(refused)).message,
    "Owned presentation metadata export refusal.",
  );
  const outside = await call("export_library_metadata", {
    path: String.raw`\\?\C:\other\metadata.json`,
  });
  assert.equal(outside.headers.get("Tauri-Response"), "error");
  const traversal = await call("export_library_metadata", {
    path: String.raw`C:\owned-native-output\..\owned-native-output\metadata.json`,
  });
  assert.equal(traversal.headers.get("Tauri-Response"), "error");
  assert.equal(forwarded.length, 1);
  const cleanup = probe.restore();
  assert.deepEqual(
    [...cleanup.mismatches],
    [
      "export_library_metadata: unexpected metadata directory",
      "export_library_metadata: unexpected metadata directory",
    ],
  );
  assert.equal(cleanup.trustworthy, false);
});

test("different picker file names remain blocked without recording their returned paths", async () => {
  const { call, forwarded, probe } = installed({ ...options, windowsPickerPaths: true });
  const paths = [
    "C:/unrelated/portcove-library.json",
    options.metadataPath + ".json",
    options.metadataPath.slice(0, -5),
    options.metadataPath + '"',
    "C:/unrelated/player-private.json",
  ];
  for (const path of paths)
    assert.equal(
      (await call("export_library_metadata", { path })).headers.get("Tauri-Response"),
      "error",
    );
  assert.deepEqual(forwarded, []);
  const cleanup = probe.restore();
  assert.equal(cleanup.trustworthy, false);
  assert.deepEqual(
    [...cleanup.mismatches],
    [
      "export_library_metadata: metadata picker returned the default file name",
      "export_library_metadata: metadata picker appended a second JSON extension",
      "export_library_metadata: metadata picker removed the JSON extension",
      "export_library_metadata: metadata picker retained a closing quote",
      "export_library_metadata: unexpected metadata file name",
    ],
  );
});

test("changed identity and malformed targeted requests fail visibly and preserve bounded trace fields", async () => {
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

test("restoration preserves a later fetch owner and rejects duplicate installation", () => {
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

test("the finite trace bound refuses further targets and records incomplete observation", async () => {
  const { call, forwarded, probe } = installed();
  for (let index = 0; index < 512; index++) await call("get_mod_setups");
  assert.equal((await call("get_mod_setups")).headers.get("Tauri-Response"), "error");
  const cleanup = probe.restore();
  assert.equal(cleanup.trace.length, 512);
  assert.equal(cleanup.mismatches.length, 1);
  assert.equal(cleanup.trustworthy, false);
  assert.deepEqual(forwarded, []);
});

test("secondary panel initialization binds its snapshot to the observed generation", async () => {
  const boundary = new Error("Observed generation-bound snapshot request");
  const library = path.resolve(root, "library");
  const commands: string[] = [];
  await assert.rejects(
    secondaryPanelsScenario({
      browser: {} as Parameters<typeof secondaryPanelsScenario>[0]["browser"],
      scenario: async (_id, action) => {
        await action();
      },
      output: root,
      library,
      artifacts: [],
      portId: options.fixtures.portId,
      confirmNative: () => assert.fail("Initialization must not open a native dialog"),
      invoke: async (command, args) => {
        commands.push(command);
        if (command === "get_bootstrap_status")
          return { ok: true, value: { generation: 7, library_root: library } };
        assert.equal(command, "get_workspace_snapshot");
        assert.deepEqual(args, { generation: 7 });
        throw boundary;
      },
    }),
    (error: unknown) => error === boundary,
  );
  assert.deepEqual(commands, ["get_bootstrap_status", "get_workspace_snapshot"]);
});

async function scenarioBoundary(
  output: string,
  {
    getRectFailure,
    foreignOwner = false,
    restoreWindowFailure = false,
    selectedLibrary = path.join(output, "library"),
  }: {
    getRectFailure?: Error;
    foreignOwner?: boolean;
    restoreWindowFailure?: boolean;
    selectedLibrary?: string;
  } = {},
) {
  const primary = new Error("Owned first window resize failure");
  const windowFailure = new Error("Owned window restoration failure");
  const original: typeof fetch = () => Promise.resolve(new Response("unrelated"));
  const foreign: typeof fetch = () => Promise.resolve(new Response("later owner"));
  const window = {
    fetch: original,
    __TAURI_INTERNALS__: {
      convertFileSrc: (command: string) => `https://owned-ipc.invalid/${command}`,
    },
    __portcoveSecondaryPanelProbe: undefined as unknown,
  };
  let scriptCalls = 0;
  let windowCalls = 0;
  const commands: string[] = [];
  const driver = {
    executeScript(script: string | ((...args: unknown[]) => unknown), ...args: unknown[]) {
      scriptCalls++;
      const result: unknown = runInNewContext(`(${script.toString()})(...__ownedArguments)`, {
        window,
        Response,
        URL,
        __ownedArguments: args,
      });
      return Promise.resolve(result);
    },
    manage: () => ({
      window: () => ({
        getRect() {
          if (getRectFailure) throw getRectFailure;
          return Promise.resolve({ x: 10, y: 20, width: 1200, height: 800 });
        },
        setRect() {
          windowCalls++;
          if (windowCalls === 1) {
            assert.ok(window.__portcoveSecondaryPanelProbe, "Install must precede the action");
            if (foreignOwner) window.fetch = foreign;
            throw primary;
          }
          if (restoreWindowFailure) throw windowFailure;
          return Promise.resolve();
        },
      }),
    }),
  };
  const context: Parameters<typeof secondaryPanelsScenario>[0] = {
    browser: driver as unknown as Parameters<typeof secondaryPanelsScenario>[0]["browser"],
    scenario: async (_id, action) => {
      await action();
    },
    output,
    library: path.join(output, "library"),
    artifacts: [],
    portId: options.fixtures.portId,
    confirmNative: () => assert.fail("Boundary failure must precede native dialogs"),
    invoke: async (command, args) => {
      commands.push(command);
      if (command === "get_bootstrap_status")
        return { ok: true, value: { generation: 7, library_root: selectedLibrary } };
      assert.equal(command, "get_workspace_snapshot");
      assert.deepEqual(args, { generation: 7 });
      return {
        ok: true,
        value: {
          statuses: [
            {
              port_id: options.fixtures.portId,
              active: { id: "owned-runtime", path: path.join(output, "library", "owned-runtime") },
            },
          ],
        },
      };
    },
  };
  return {
    primary,
    original,
    foreign,
    window,
    commands,
    scripts: () => scriptCalls,
    windowCalls: () => windowCalls,
    run: () => secondaryPanelsScenario(context),
  };
}

test("an unexpected selected library is refused before fixture files or probe installation", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-panel-library-"));
  try {
    const boundary = await scenarioBoundary(output, {
      selectedLibrary: path.join(output, "another-library"),
    });
    await assert.rejects(boundary.run(), /exact owned library/u);
    assert.deepEqual(await readdir(output), []);
    assert.deepEqual(boundary.commands, ["get_bootstrap_status"]);
    assert.equal(boundary.scripts(), 0);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("a window observation failure precedes probe installation", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-panel-rect-"));
  try {
    const failure = new Error("Owned getRect failure");
    const boundary = await scenarioBoundary(output, { getRectFailure: failure });
    await assert.rejects(boundary.run(), (error: unknown) => error === failure);
    assert.equal(boundary.scripts(), 0);
    assert.equal(boundary.window.__portcoveSecondaryPanelProbe, undefined);
    assert.equal(boundary.window.fetch, boundary.original);
    assert.equal(isUntrustworthyProbeError(failure), false);
    assert.equal(boundary.windowCalls(), 0);
    assert.equal((await readdir(output)).length, 4);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("trustworthy cleanup retains the action failure when window restoration also fails", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-panel-window-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const boundary = await scenarioBoundary(output, { restoreWindowFailure: true });
    await assert.rejects(boundary.run(), (error: unknown) => error === boundary.primary);
    assert.equal(boundary.window.fetch, boundary.original);
    assert.equal(boundary.window.__portcoveSecondaryPanelProbe, undefined);
    assert.equal(boundary.windowCalls(), 2);
    assert.equal(isUntrustworthyProbeError(boundary.primary), false);
    const report = object(
      JSON.parse(await readFile(path.join(output, "secondary-panels-observations.json"), "utf8")),
    );
    assert.equal(object(report.probe).trustworthy, true);
    assert.equal(report.outcome, "failed");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("foreign probe ownership remains marked despite receipt and window restoration failures", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-panel-custody-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const receipt = path.join(output, "secondary-panels-observations.json");
    await mkdir(receipt);
    const boundary = await scenarioBoundary(output, {
      foreignOwner: true,
      restoreWindowFailure: true,
    });
    await assert.rejects(boundary.run(), (error: unknown) => error === boundary.primary);
    assert.equal(isUntrustworthyProbeError(boundary.primary), true);
    assert.equal(boundary.window.fetch, boundary.foreign);
    assert.ok(boundary.window.__portcoveSecondaryPanelProbe);
    assert.equal(boundary.windowCalls(), 2);
    assert.deepEqual(await readdir(receipt), []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
