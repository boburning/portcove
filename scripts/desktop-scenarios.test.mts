import {
  observeDesktopScenario,
  recordDesktopCheck,
  type ScenarioObservation,
} from "../apps/desktop/scripts/desktop-scenario-outcomes.mts";
import "../apps/desktop/scripts/desktop-catalog-update.native.test.mts";
import "../apps/desktop/scripts/desktop-design-compatibility.native.test.mts";
import "../apps/desktop/scripts/desktop-remainder-scenarios.native.test.mts";
import type { EvidenceCheck, FileIdentity } from "./development-evidence.mts";
import type { FixtureSpawn } from "../apps/desktop/scripts/desktop-scenario-state.mts";
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function values(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function json(value: string | Buffer): unknown {
  return JSON.parse(typeof value === "string" ? value : value.toString("utf8"));
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
// VM source is untrusted at the test boundary. Narrow callable shape, then check each observation.
function sourceFunction(value: unknown) {
  assert.ok(typeof value === "function");
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(value, undefined, args);
    return result;
  };
}
import { errorCode, isRecord } from "./runtime-values.mts";
import { runDesktopModuleFixture } from "./fixtures/desktop-module-fixture.mts";
import "../apps/desktop/scripts/desktop-completion-focus.native.test.mts";
import { assertReviewFieldPresentation } from "../apps/desktop/scripts/desktop-review-presentation.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import "../apps/desktop/scripts/desktop-main-webview-boundary.native.test.mts";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { runTypeScriptInNewContext as runInNewContext } from "./test-source.mts";
import { ownedFixtureCommand } from "../apps/desktop/scripts/desktop-scenario-state.mts";
import { requireTrustedProbeCleanup } from "../apps/desktop/scripts/desktop-owned-ipc-probe.mts";

void test("owned fixture CLI binds catalog, preferences, literal selection and refuses failed responses", () => {
  const calls: Parameters<FixtureSpawn>[] = [];
  let response: ReturnType<FixtureSpawn> = {
    status: 0,
    stdout: JSON.stringify({ ok: true, data: { owned: true } }),
  };
  const command = ownedFixtureCommand(
    {
      cli: "owned-cli",
      library: "default library",
      output: "owned-output",
      catalogPath: "owned-catalog",
    },
    (...args) => {
      calls.push(args);
      return response;
    },
  );
  assert.deepEqual(command(["source", "list"], "literal $selected library"), { owned: true });
  const [exe, args, options] = required(calls[0]);
  assert.ok(options.env);
  assert.equal(exe, "owned-cli");
  assert.deepEqual(args, [
    "--library",
    "literal $selected library",
    "--json",
    "--non-interactive",
    "source",
    "list",
  ]);
  assert.equal(options.env.PORTCOVE_QUALIFICATION_CATALOG, "owned-catalog");
  assert.equal(options.env.PORTCOVE_PREFERENCES, path.join("owned-output", "preferences.json"));
  assert.equal(options.timeout, 15_000);
  for (response of [
    { status: 1, stderr: "original failure" },
    { status: 0, stdout: '{"ok":false}' },
    { status: 0, stdout: "incomplete" },
  ])
    assert.throws(() => command(["status"]));
});

void test("review presentation executes its actual serialized browser observation", async () => {
  const field = { role: "field" },
    label = { role: "label" },
    dialog = { role: "dialog" };
  const fieldStyle = {
    width: "200px",
    paddingLeft: "10px",
    borderStyle: "solid",
    borderWidth: "1px",
    backgroundColor: "rgb(1, 1, 1)",
    color: "rgb(250, 250, 250)",
  };
  const labelStyle = { fontWeight: "700", color: "rgb(240, 240, 240)" };
  const dialogStyle = { backgroundColor: "rgb(2, 2, 2)" };
  let calls = 0;
  const browser = {
    executeScript: async (callback: unknown, ...elements: unknown[]) => {
      calls++;
      assert.equal(typeof callback, "function");
      assert.deepEqual(elements, [field, label, dialog]);
      // WebDriver serializes the actual callback. VM execution here models
      // that browser boundary, rather than slicing declarations from a file.
      return runInNewContext(`(${String(callback)})(...elements)`, {
        elements,
        getComputedStyle(element: unknown) {
          if (element === field) return fieldStyle;
          if (element === label) return labelStyle;
          assert.equal(element, dialog);
          return dialogStyle;
        },
      });
    },
  };
  const result = await sourceFunction(assertReviewFieldPresentation)(browser, field, label, dialog);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ...fieldStyle,
    dialogBackgroundColor: dialogStyle.backgroundColor,
    labelColor: labelStyle.color,
    labelFontWeight: labelStyle.fontWeight,
  });
  assert.equal(calls, 1);
});

void test(
  "native review facade consumes the importable presentation helper without optional packages",
  { timeout: 25_000 },
  () => {
    const entry = new URL("../apps/desktop/scripts/desktop-review-controls.mts", import.meta.url);
    const seam = new URL(
      "../apps/desktop/scripts/desktop-review-presentation.mts",
      import.meta.url,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';
        import { registerHooks } from 'node:module';
        const entry = ${JSON.stringify(entry.href)};
        const optional = {
          'selenium-webdriver': 'export const By = {}, Key = {}, until = {};',
          'axe-core': 'export default {};',
        };
        registerHooks({ resolve(specifier, context, next) {
          if (context.parentURL === entry && Object.hasOwn(optional, specifier))
            return { url: 'data:text/javascript,' + encodeURIComponent(optional[specifier]), shortCircuit: true };
          return next(specifier, context);
        }});
        const facade = await import(entry);
        const seam = await import(${JSON.stringify(seam.href)});
        assert.equal(facade.assertReviewFieldPresentation, seam.assertReviewFieldPresentation);
        const field = {}, label = {}, dialog = {};
        const observation = { width: '200px', paddingLeft: '10px', borderStyle: 'solid',
          borderWidth: '1px', backgroundColor: 'rgb(1, 1, 1)',
          dialogBackgroundColor: 'rgb(2, 2, 2)', labelFontWeight: '700' };
        let calls = 0;
        const browser = { async executeScript(callback, ...elements) {
          assert.equal(typeof callback, 'function');
          assert.deepEqual(elements, [field, label, dialog]);
          calls++;
          return observation;
        }};
        assert.equal(await facade.assertReviewFieldPresentation(browser, field, label, dialog), observation);
        assert.equal(calls, 1);
        console.log('Review presentation wiring: complete');`,
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Review presentation wiring: complete");
  },
);

void test("shared review presentation preserves native visual acceptance thresholds", async () => {
  const invokePresentation = sourceFunction(assertReviewFieldPresentation);
  const valid = {
    width: "200px",
    paddingLeft: "10px",
    borderStyle: "solid",
    borderWidth: "1px",
    backgroundColor: "rgb(1, 1, 1)",
    dialogBackgroundColor: "rgb(2, 2, 2)",
    labelFontWeight: "700",
  };
  const field = {},
    label = {},
    dialog = {};
  let observation = valid;
  const browser = {
    executeScript: async (_script: unknown, ...args: unknown[]) => {
      assert.deepEqual(args, [field, label, dialog]);
      return observation;
    },
  };
  assert.equal(await invokePresentation(browser, field, label, dialog), valid);
  for (const [key, value] of [
    ["width", "199px"],
    ["paddingLeft", "9px"],
    ["borderStyle", "none"],
    ["borderWidth", "0px"],
    ["backgroundColor", "rgba(0, 0, 0, 0)"],
    ["backgroundColor", valid.dialogBackgroundColor],
    ["labelFontWeight", "699"],
  ] as const) {
    observation = { ...valid, [key]: value };
    await assert.rejects(Promise.resolve(invokePresentation(browser, field, label, dialog)));
  }
});

void test("the native entrypoint awaits its observer and retains failures through imported owners", async () => {
  const caller = stripTypeScriptTypes(
    await readFile(new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  const imported = caller.match(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\/desktop-scenario-outcomes\.mts["']/u,
  );
  for (const [owner, awaited] of [
    ["observeDesktopScenario", true],
    ["recordDesktopCheck", false],
  ] as const) {
    const observer = imported?.[1]?.match(
      new RegExp(`\\b${owner}\\b(?:\\s+as\\s+([$\\w]+))?`, "u"),
    );
    assert.ok(observer, `The actual native entrypoint must import ${owner}`);
    const binding = (observer[1] ?? owner).replaceAll("$", "\\$");
    assert.match(
      caller,
      new RegExp(`${awaited ? "\\bawait\\s+" : "(?<![$\\w])"}${binding}\\s*\\(`, "u"),
    );
  }
});

for (const scope of ["scenario-action", "harness"] as const)
  void test(`${scope} failure survives actual evidence publication failure with bounded identity`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-native-publication-failure-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "ordinary file blocks evidence output");
    const retained: string[] = [];
    t.mock.method(console, "error", (line: unknown) => retained.push(String(line)));
    const primary = new Error(`Original native scenario failure: ${"x".repeat(8000)}`);
    const revision = "a".repeat(40);
    const records: EvidenceCheck[] = [];
    let tick = 0;
    if (scope === "scenario-action")
      await observeDesktopScenario(
        () => {
          throw primary;
        },
        {
          record: (observation) => {
            recordDesktopCheck(records, revision, {
              scenario: "owned-native-case",
              ...observation,
              duration_scope: "scenario-action",
            });
          },
          diagnostics: async () => {},
          screenshot: async () => {},
        },
        () => tick++ * 25,
      );
    else
      recordDesktopCheck(records, revision, {
        scenario: "harness",
        outcome: "failed",
        message: primary.message,
      });
    assert.equal(retained.length, 1, "Failure must be retained before publication starts");
    await assert.rejects(
      writeEvidence(blocked, {
        revision,
        executable: process.execPath,
        capturedExecutable: await fileIdentity(process.execPath),
        method: "controlled-writer-failure",
        checks: records,
        artifacts: [],
      }),
      (error) => ["ENOTDIR", "ENOENT"].includes(errorCode(error) ?? ""),
    );
    const prefix = "DESKTOP_FAILURE ";
    assert.ok(required(retained[0]).startsWith(prefix));
    const packet = object(json(required(retained[0]).slice(prefix.length)));
    assert.equal(packet.outcome, "failed");
    assert.equal(packet.scenario, scope === "scenario-action" ? "owned-native-case" : "harness");
    assert.equal(packet.duration_ms, scope === "scenario-action" ? 25 : null);
    assert.equal(packet.duration_scope, scope);
    assert.equal(packet.platform, process.platform);
    assert.equal(packet.architecture, process.arch);
    assert.deepEqual(packet.source, { kind: "declared-harness-revision", revision });
    assert.equal(packet.message, primary.message.slice(0, 4096));
    assert.equal(packet.message_truncated, true);
    assert.ok(required(retained[0]).length < 5000);
  });

void test("untrustworthy probe cleanup retains the primary error and reaches outer teardown", async () => {
  const records: ScenarioObservation[] = [];
  const primary = new Error("Original owned scenario failure");
  Object.freeze(primary);
  requireTrustedProbeCleanup({ trustworthy: false }, primary);
  let tick = 0;
  await assert.rejects(
    observeDesktopScenario(
      () => {
        throw primary;
      },
      {
        record: (observation) => records.push(observation),
        diagnostics: async () => {},
        screenshot: async () => assert.fail("Untrustworthy session must enter outer teardown"),
      },
      () => tick++ * 10,
    ),
    (error) => error === primary,
  );
  assert.deepEqual(records, [{ outcome: "failed", message: primary.message, duration_ms: 10 }]);
});

void test("scenario action timings exclude diagnostics and screenshots and preserve reporting failures", async () => {
  for (const failed of [false, true]) {
    for (const reportFailed of [false, true]) {
      const primary = new Error("Original scenario failure");
      const reporting = new Error("Observation could not be retained");
      let clock = 100;
      const records: ScenarioObservation[] = [];
      const attempt = observeDesktopScenario(
        () => {
          clock += 25;
          if (failed) throw primary;
        },
        {
          record: (observation) => {
            records.push(observation);
            if (reportFailed) throw reporting;
          },
          diagnostics: async () => {
            clock += 1000;
          },
          screenshot: async () => {
            clock += 2000;
          },
        },
        () => clock,
      );
      if (reportFailed)
        await assert.rejects(attempt, (error) => error === (failed ? primary : reporting));
      else await attempt;
      assert.deepEqual(records, [
        {
          outcome: failed ? "failed" : "passed",
          duration_ms: 25,
          ...(failed ? { message: primary.message } : {}),
        },
      ]);
      if (!reportFailed) assert.equal(clock, failed ? 3125 : 2125);
    }
  }
});

void test("scan cleanup attempts every owned action and retains the primary scenario failure", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-source-dialog-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function progressiveScanNavigation(");
  const end = source.indexOf("export async function sourceDialogScenario(", start);
  assert(start >= 0 && end > start);
  const primary = new Error("Original scan navigation failure");
  const reads = new Map<string, number>();
  const actions: string[] = [];
  let report: unknown;
  const fixture = {
    profile_id: "owned-profile",
    path: "owned-source",
    sha256: "owned-sha",
    size: 1,
  };
  const command = (args: readonly string[]) => {
    const action = args.join(" ");
    const count = reads.get(action) ?? 0;
    reads.set(action, count + 1);
    if (action === "source roots add owned-root") return { id: "owned-root-id" };
    if (action === "catalog list")
      return [{ id: "owned-port", name: "Owned", source_profile: fixture.profile_id }];
    if (action === "source roots remove owned-root-id") {
      actions.push("remove-owned-root");
      throw new Error("Owned root removal failed");
    }
    if (count) {
      actions.push(action);
      return "Incorrect cleanup readback";
    }
    if (action === "source list") return [fixture];
    if (action === "source roots list") return [];
    if (action === "status owned-port") return { owned: true };
    assert.fail(action);
  };
  const navigate = sourceFunction(
    runInNewContext(`${source.slice(start, end)}\nprogressiveScanNavigation`, {
      assert,
      path,
      // This dependency-free source-slice fixture isolates cleanup ordering.
      // Rust-schema admission is tested by transport-values.test.mts; these
      // deliberate partial/incorrect observations must still reach cleanup checks.
      transportValue: (_contract: unknown, value: unknown) => value,
      transportValues: (_contract: unknown, value: unknown) => value,
      gameFileRoot: (value: unknown) => value,
      object: (value: unknown) => value,
      rethrowFailure: (error: unknown) => {
        throw error;
      },
      requireTrustedProbeCleanup,
      reviewControls: () => ({
        button: (name: string) => name,
        click: async () => {
          throw primary;
        },
      }),
      writeFile: async (_path: string, bytes: string) => {
        report = json(bytes);
      },
      console: { error() {} },
    }),
  );
  await assert.rejects(
    Promise.resolve(
      navigate({
        browser: {
          executeScript: async () => {
            throw new Error("Owned capture unavailable");
          },
        },
        output: "owned-output",
        artifacts: [],
        command,
        port: { id: "owned-port", source_profile: fixture.profile_id },
        searchRoot: "owned-root",
      }),
    ),
    (error) => error === primary,
  );
  assert.deepEqual(actions, [
    "remove-owned-root",
    "source roots list",
    "source list",
    "status owned-port",
  ]);
  const observed = object(report);
  assert.equal(observed.failure, primary.message);
  const cleanup = values(observed.owned_cleanup);
  assert.equal(cleanup.length, 4);
  assert(
    cleanup.every((outcome) => object(outcome).attempted && object(outcome).completed === false),
  );
});
import { createInstallFixture } from "../apps/desktop/scripts/desktop-install-fixture.mts";
import { fileIdentity, writeEvidence } from "./development-evidence.mts";
import { toolCachePaths } from "./tool-cache.mts";
import { pathToFileURL } from "node:url";
import {
  readHistoryProcess,
  captureHistorySession,
  historyDriverStillOwned,
  waitHistorySessionExit,
  qualificationHistoryScenario,
} from "../apps/desktop/scripts/desktop-qualification-history-test.mts";

void test("history opens populated details before waiting for requested inspections", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "pcv-history-caller-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const entry = new URL(
    "../apps/desktop/scripts/desktop-qualification-history-test.mts",
    import.meta.url,
  );
  const program = `
    import {runInNewContext} from 'node:vm';import {readFile} from 'node:fs/promises';import path from 'node:path';
    // Controlled module execution preserves the original platform-neutral case.
    // Native processes are forbidden by the surrounding fixture, including on Windows.
    Object.defineProperty(process,'platform',{value:'linux'});
    const output=${JSON.stringify(output)},events=[],artifacts=[];
    const sentinel=Error('History startup reached its first presentation branch');
    const window={__portcoveHistoryProbe:undefined};
    const document={documentElement:{style:{fontSize:''}}};
    let fixture,asyncCalls=0,waits=0,sourceReads=0;
    const browser={
      manage:()=>({window:()=>({getRect:async()=>({width:800,height:600}),setRect:async()=>{}})}),
      executeScript:async(callback,...args)=>runInNewContext('('+String(callback)+')(...args)',{window,document,args,getComputedStyle:()=>({fontSize:'16px'})}),
      executeAsyncScript:async(callback,...args)=>{
        assert.equal(typeof callback,'function');
        if(++asyncCalls===1){
          [fixture]=args;assert.ok(fixture.port_id&&fixture.profile_id);
          window.__portcoveHistoryProbe={snapshots:1,reports:0};events.push('fixture');return {ok:true};
        }
        assert.equal(asyncCalls,2);return {restored:true,snapshots:1,reports:1};
      },
      findElement:(locator)=>{
        if(locator.value==='//nav//button[contains(., "Settings")]')throw sentinel;
        if(locator.value==='//nav//button[contains(., "Discover")]')return {click:async()=>events.push('discover')};
        assert.deepEqual(locator,{using:'css selector',value:'.detail-panel'});
        return {getText:async()=>'165 Hz host'};
      },
      wait:async(predicate,budget,message)=>{
        assert.equal(budget,15000);assert.equal(await predicate(),true);
        if(++waits===2)assert.equal(message,'Populated production history did not settle; A16 component composition is required');
        else assert.equal(message,undefined);
        events.push('settled');
      },
    };
    mock.module(new URL('./desktop-review-controls.mts',entry).href,{namedExports:{selectCatalogPort:async(actual,port)=>{
      assert.equal(actual,browser);assert.equal(port,fixture.port_id);events.push('details');window.__portcoveHistoryProbe.reports++;
    }}});
    const {qualificationHistoryScenario}=await import(entry);
    await assert.rejects(qualificationHistoryScenario({browser,output,artifacts,
      invoke:async(command)=>{assert.equal(command,'get_sources');sourceReads++;return {ok:true,value:[]};},
      scenario:async(name,action)=>{assert.equal(name,'native-qualification-history');await action();},
      captureScreenshot:async()=>assert.fail('Startup control may not reach screenshot work'),
    }),error=>error===sentinel);
    assert.deepEqual(events,['fixture','settled','discover','details','settled','settled']);
    assert.equal(asyncCalls,2);assert.equal(sourceReads,1);
    assert.equal(artifacts.length,1);assert.equal(artifacts[0],path.join(output,'qualification-history.json'));
    const report=JSON.parse(await readFile(artifacts[0],'utf8'));
    assert.equal(report.failure.message,sentinel.message);assert.equal(report.restoration.restored,true);assert.equal(report.native_source_restoration.count,0);
  `;
  runDesktopModuleFixture(entry, program);
  await rm(path.join(output, "qualification-history.json"));
  runDesktopModuleFixture(entry, program, {
    exportName: "qualificationHistoryScenario",
    variant: "aliased",
  });
  await rm(path.join(output, "qualification-history.json"));
  assert.throws(() =>
    runDesktopModuleFixture(entry, program, {
      exportName: "qualificationHistoryScenario",
      variant: "wrong-export",
    }),
  );
});

void test("history procfs disappearance retains narrow errors and live identities", async () => {
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EIO"]) {
    const error = Object.assign(new Error(code), { code });
    const action = readHistoryProcess(123, {
      read: async () => {
        throw error;
      },
      link: async () => {
        assert.fail("Disappeared stat must not read executable");
      },
    });
    if (["ENOENT", "ESRCH"].includes(code)) assert.equal(await action, null);
    else await assert.rejects(Promise.resolve(action), (actual: unknown) => actual === error);
  }
  const fields = ["S", "10", "123", ...Array<string>(16).fill("0"), "456"];
  const live = await readHistoryProcess(123, {
    read: async (file, encoding) => {
      assert.equal(file, "/proc/123/stat");
      assert.equal(encoding, "utf8");
      return `123 (owned child) ${fields.join(" ")}`;
    },
    link: async (file) => {
      assert.equal(file, "/proc/123/exe");
      return "/owned/driver";
    },
  });
  assert.deepEqual(
    { ...object(live) },
    {
      state: "S",
      pid: 123,
      parent: 10,
      group: 123,
      start_ticks: "456",
      executable: "/owned/driver",
    },
  );
  for (const startTicks of ["untrusted", "-1", "0.5"]) {
    const invalid = [...fields];
    invalid[19] = startTicks;
    let executableReads = 0;
    await assert.rejects(
      readHistoryProcess(123, {
        read: async () => `123 (owned child) ${invalid.join(" ")}`,
        link: async () => {
          executableReads++;
          return "/owned/driver";
        },
      }),
      { code: "ERR_ASSERTION" },
    );
    assert.equal(executableReads, 0, "Malformed stat must fail before reading executable");
  }
  for (const code of ["ENOENT", "EACCES", "EPERM"]) {
    const failure = Object.assign(new Error(code), { code });
    const actual = await readHistoryProcess(123, {
      read: async () => `123 (owned child) ${fields.join(" ")}`,
      link: async () => {
        throw failure;
      },
    });
    assert.ok(actual);
    assert.equal(actual.executable, null);
    assert.equal(actual.start_ticks, "456");
  }
  const error = Object.assign(new Error("exe disappearance"), { code: "ESRCH" });
  await assert.rejects(
    Promise.resolve(
      readHistoryProcess(123, {
        read: async () => `123 (owned child) ${fields.join(" ")}`,
        link: async () => {
          throw error;
        },
      }),
    ),
    (actual: unknown) => actual === error,
  );
});

void test("history fixture helpers import without installed desktop packages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-history-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = path.join(root, "apps/desktop/scripts/desktop-qualification-history-test.mts");
  await mkdir(path.dirname(module), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await copyFile(
    new URL("./runtime-values.mts", import.meta.url),
    path.join(root, "scripts/runtime-values.mts"),
  );
  await copyFile(
    new URL("../apps/desktop/scripts/browser-script.mts", import.meta.url),
    path.join(root, "apps/desktop/scripts/browser-script.mts"),
  );
  await copyFile(
    new URL("../apps/desktop/scripts/desktop-qualification-history-test.mts", import.meta.url),
    module,
  );
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(module).href)})`],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const native = path.join(
    root,
    "apps/desktop/scripts/desktop-qualification-history.native.test.mts",
  );
  await copyFile(
    new URL(
      "../apps/desktop/scripts/desktop-qualification-history.native.test.mts",
      import.meta.url,
    ),
    native,
  );
  const guard = path.join(root, "no-packages.mjs");
  await writeFile(
    guard,
    `import {registerHooks,isBuiltin} from 'node:module';registerHooks({resolve(specifier,context,next){if(!isBuiltin(specifier)&&!specifier.startsWith('.')&&!specifier.startsWith('file:')&&!specifier.startsWith('data:'))throw Error('Optional package forbidden: '+specifier);return next(specifier,context);}});`,
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const execution = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(guard).href, "--test", "--test-reporter=tap", native],
    { cwd: root, env: environment, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  assert.ifError(execution.error);
  assert.equal(execution.status, 0, execution.stderr + execution.stdout);
  assert.match(execution.stdout, /^# pass 3$/mu);
  assert.match(execution.stdout, /^# skipped 0$/mu);
});

void test(
  "history installation and lost-window failures retain original and restoration evidence",
  {
    skip:
      process.platform !== "linux" &&
      "platform: linux; requires Linux process identity; route: ci.yml/frontend_full (frontend-full-4)",
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-history-restoration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const lostWindow of [false, true]) {
      const output = path.join(root, String(lostWindow));
      await mkdir(output);
      let calls = 0;
      const browser = {
        manage: () => ({
          window: () => ({
            getRect: async () => ({ width: 800, height: 600 }),
            setRect: async () => {
              if (lostWindow) throw new Error("owned window unavailable");
            },
          }),
        }),
        executeScript: async () => "",
        executeAsyncScript: async () => {
          if (++calls === 1) return { error: "owned installation emit rejected" };
          if (lostWindow) throw new Error("owned restoration unavailable");
          return { restored: true, snapshots: 0, reports: 0 };
        },
      };
      await assert.rejects(() =>
        qualificationHistoryScenario({
          // @ts-expect-error Deliberately partial driver: failure precedes omitted native operations.
          browser,
          scenario: async (_name, body) => body(),
          output,
          artifacts: [],
          invoke: async () => ({ ok: true, value: [] }),
        }),
      );
      const report = object(
        json(await readFile(path.join(output, "qualification-history.json"), "utf8")),
      );
      assert.match(text(object(report.failure).message), /owned installation emit rejected/);
      assert.equal(calls, 2, "Installation rejection still attempts restoration exactly once");
      assert.equal(object(report.restoration).restored, !lostWindow);
      assert.equal(object(report.native_source_restoration).count, 0);
      if (lostWindow) {
        assert.equal(object(report.restoration).error, "owned restoration unavailable");
        assert.equal(object(report.restoration).window_error, "owned window unavailable");
      }
    }
  },
);

void test(
  "history ownership rejects an unrelated PID and changed creation identity without signaling",
  {
    skip:
      process.platform !== "linux" &&
      "platform: linux; requires Linux process identity; route: ci.yml/frontend_full (frontend-full-4)",
  },
  async () => {
    const raw = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const driver = {
      pid: process.pid,
      parent: Number(fields[1]),
      group: Number(fields[2]),
      state: required(fields[0]),
      start_ticks: required(fields[19]),
      executable: await readlink(`/proc/${process.pid}/exe`),
    };
    assert.equal(await historyDriverStillOwned({ driver }), true);
    await assert.rejects(
      () => historyDriverStillOwned({ driver: { ...driver, start_ticks: "0" } }),
      /start_ticks changed/,
    );
    await assert.rejects(
      () => captureHistorySession(process.pid, process.execPath, process.execPath),
      /Expected values to be strictly equal/,
    );
    const oldIdentity = await waitHistorySessionExit({
      processes: [{ ...driver, start_ticks: "0" }],
    });
    assert.equal(oldIdentity.all_exited, true);
    assert.equal(
      await historyDriverStillOwned({ driver }),
      true,
      "An unrelated current process must be retained",
    );
  },
);
import {
  createExternalRuntimeFixture,
  externalFixtureTreeDigest,
  externalRuntimePickerObservation,
  externalRuntimeReviewScenario,
} from "../apps/desktop/scripts/desktop-external-runtime-test.mts";
import { nativePreparedRuntimePicker } from "../apps/desktop/scripts/desktop-native-confirmation.mts";
import {
  verifyNormalPackageEvidence,
  assertOwnedBoundaryRequests,
  normalPackageBoundaryScenario,
  verifyLinuxPackageEvidence,
  assertMainWebviewContainment,
} from "../apps/desktop/scripts/desktop-main-webview-boundary.mts";

void test("failed permission command retains bounded redacted progress without acceptance or error replacement", async () => {
  async function run(mode: string) {
    const original = new Error("Owned permission command timed out");
    const observations: Record<string, unknown> = {};
    const window: { __portcovePermissionProgress?: unknown } = {};
    let reads = 0;
    const browser = {
      executeAsyncScript: async (callback: unknown) => {
        assert.ok(typeof callback === "function");
        const source = callback.toString();
        if (source.includes("window.open")) return { refused: true };
        if (source.includes("securitypolicyviolation"))
          return { executed: false, blockedUri: "inline" };
        assert.ok(source.includes("Notification.requestPermission"));
        runInNewContext(`(${source})(done)`, {
          window,
          done: () => assert.fail("Pending media must not complete the command"),
          Notification: { requestPermission: () => Promise.resolve("denied") },
          navigator: {
            geolocation: {
              getCurrentPosition: (
                _success: unknown,
                failure: (value: unknown) => void,
                constraints: { timeout: number },
              ) => {
                assert.equal(constraints.timeout, 5000);
                failure({ code: 1 });
              },
            },
            mediaDevices: {
              getUserMedia: (constraints: unknown) => {
                assert.deepEqual(json(JSON.stringify(constraints)), {
                  audio: true,
                  video: true,
                });
                return new Promise(() => {});
              },
            },
          },
        });
        await new Promise((resolve) => setImmediate(resolve));
        if (mode === "foreign")
          window.__portcovePermissionProgress = {
            notifications: "owned-private-value",
            geolocation: "code-1",
            media: { private: "owned-private-value" },
            extra: "owned-private-value",
          };
        throw original;
      },
      executeScript: async (callback: unknown) => {
        assert.ok(typeof callback === "function");
        reads++;
        if (mode === "read-error") throw new Error("owned-private-value");
        if (mode === "deadline") return new Promise(() => {});
        return runInNewContext(`(${callback.toString()})()`, { window });
      },
    };
    await assert.rejects(
      assertMainWebviewContainment({
        // @ts-expect-error Permission-failure fixture intentionally omits later navigation capabilities.
        browser,
        invoke: async (command) => {
          assert.equal(command, "get_locale_preference");
          return { value: { locale: "en" } };
        },
        observations,
        onNavigation: () => assert.fail("Original permission failure must stop navigation"),
      }),
      (error) => error === original,
    );
    assert.equal(reads, 1);
    assert.equal(Object.hasOwn(observations, "permissionRequests"), false);
    assert.ok(!JSON.stringify(observations).includes("owned-private-value"));
    return json(JSON.stringify(observations.permissionRequestDiagnostic));
  }
  assert.deepEqual(await run("captured"), {
    status: "captured",
    requests: { notifications: "denied", geolocation: "code-1", media: "pending" },
  });
  assert.deepEqual(await run("foreign"), {
    status: "captured",
    requests: { notifications: "unclassified", geolocation: "code-1", media: "unclassified" },
  });
  assert.deepEqual(await run("read-error"), { status: "unavailable", reason: "read-error" });
  assert.deepEqual(await run("deadline"), { status: "unavailable", reason: "deadline" });
});

void test("Linux packaged boundary refuses substituted payload, producer and qualification evidence", async (t) => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-linux-packaged-webview-boundary"],
    platform: "linux",
  });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: ["native-linux-packaged-webview-boundary", "empty-library"],
        platform: "linux",
      }),
    /standalone/,
  );
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-linux-packaged-webview-boundary"));
  const work = path.resolve("work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "linux-package-contract-"));
  t.after(async () => {
    assert.equal(path.dirname(root), work);
    await rm(root, { recursive: true });
  });
  await mkdir(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  const configuration = [];
  for (const name of ["tauri.conf.json", "Cargo.toml"]) {
    const file = path.join(root, "apps/desktop/src-tauri", name);
    await writeFile(file, "owned configuration");
    configuration.push(await fileIdentity(file));
  }
  const packagePath = path.join(root, "owned.deb"),
    payload = path.join(root, "payload");
  await writeFile(packagePath, "owned package");
  await mkdir(path.join(payload, "usr/bin"), { recursive: true });
  const executablePath = path.join(payload, "usr/bin/portcove-desktop");
  await writeFile(executablePath, "owned executable");
  const executable = await fileIdentity(executablePath),
    packageIdentity = await fileIdentity(packagePath);
  const receiptPath = path.join(root, "extraction.json");
  await writeFile(
    receiptPath,
    JSON.stringify({
      exit_code: 0,
      package_sha256: packageIdentity.sha256,
      executable_sha256: executable.sha256,
      payload_root: payload,
      command: ["dpkg-deb", "--extract", packagePath, payload],
    }),
  );
  const manifest = {
    revision: "a".repeat(40),
    build_command: ["pnpm", "--dir", "apps/desktop", "desktop:build", "--bundles", "deb"],
    qualification_features: [] as string[],
    execution_context: "extracted-deb-payload",
    configuration,
    package: packageIdentity,
    extraction_evidence: await fileIdentity(receiptPath),
  };
  const file = path.join(root, "manifest.json");
  const save = () => writeFile(file, JSON.stringify(manifest));
  await save();
  await verifyLinuxPackageEvidence(file, manifest.revision, executable, root);
  await assert.rejects(verifyLinuxPackageEvidence(file, "b".repeat(40), executable, root));
  await assert.rejects(
    verifyLinuxPackageEvidence(
      file,
      manifest.revision,
      { ...executable, path: path.join(root, "outside") },
      root,
    ),
  );
  manifest.qualification_features = ["native-compatibility-qualification"];
  await save();
  await assert.rejects(verifyLinuxPackageEvidence(file, manifest.revision, executable, root));
  manifest.qualification_features = [];
  await save();
  await writeFile(executablePath, "substituted executable");
  await assert.rejects(verifyLinuxPackageEvidence(file, manifest.revision, executable, root));
  await writeFile(executablePath, "owned executable");
  await writeFile(packagePath, "substituted package");
  await assert.rejects(verifyLinuxPackageEvidence(file, manifest.revision, executable, root));
});
import { assertSteamEntryContext } from "../apps/desktop/scripts/desktop-context-contract.mts";
import { OwnedNativeSession } from "../apps/desktop/scripts/desktop-owned-native-session.mts";
import { observeStartupNetwork } from "../apps/desktop/scripts/desktop-startup-network-diagnostic.mts";
import { DatabaseSync } from "node:sqlite";
import {
  librarySwitchRecoverySelection,
  prepareLibrarySwitchRecoveryFixture,
} from "../apps/desktop/scripts/desktop-library-switch-recovery-test.mts";
import {
  bootstrapRecoveryEnvironment,
  bootstrapRecoverySelection,
  prepareBootstrapRecoveryFixture,
  preferencesRecoverySelection,
  preparePreferencesRecoveryFixture,
  technicalDetailHasSeparation,
} from "../apps/desktop/scripts/desktop-bootstrap-recovery-test.mts";
import {
  catalogReport,
  desktopHarnessDeadlineMs,
  desktopScenarioById,
  DESKTOP_PROFILES,
  DESKTOP_SCENARIOS,
  resolveDesktopSelection,
} from "./desktop-scenarios.mts";

void test("qualification history is one opt-in Linux normal-app scenario without lifecycle setup", () => {
  const selected = resolveDesktopSelection({
    scenarios: ["native-qualification-history"],
    platform: "linux",
  });
  assert.deepEqual(selected.selected_scenarios, ["native-qualification-history"]);
  assert.deepEqual(selected.setup_scenarios, []);
  assert.deepEqual(selected.prerequisites, ["desktop"]);
  assert.equal(desktopHarnessDeadlineMs(selected), 180_000);
  assert.equal(
    Object.values(DESKTOP_PROFILES).some((ids) => ids.includes("native-qualification-history")),
    false,
  );
});

void test("native history fixture reuses exact maintained catalog records without inventing current applicability", async () => {
  const { qualificationHistoryFixture } =
    await import("../apps/desktop/scripts/desktop-qualification-history-test.mts");
  const catalog = json(
    await readFile(
      new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const fixture = qualificationHistoryFixture(catalog);
  assert.equal(fixture.profile_id, fixture.report.expected_identity.id);
  assert.equal(fixture.report.applications[0].contract.profile_id, fixture.profile_id);
  assert.deepEqual(
    fixture.report.applications[0].qualification.exact_records,
    values(object(object(catalog).source_catalog).qualification).filter(
      (record) => object(object(record).scope).port_id === fixture.port_id,
    ),
  );
  assert.equal(fixture.report.state_code, "not_inspected");
  assert.equal(fixture.report.applications[0].release_applicability.state_code, "not_rebound");
  assert.throws(() => qualificationHistoryFixture({ ports: [], source_catalog: {} }));
});

void test("external fixture contracts execute without installed native-driver dependencies", async (t) => {
  // Storage guards can put os.tmpdir() inside an installed workspace. Keep this
  // small module fixture outside its dependency ancestry and prove resolution fails.
  const isolation = path.join(toolCachePaths().sharedRoot, "node-contracts");
  await mkdir(isolation, { recursive: true });
  const root = await mkdtemp(path.join(isolation, "native-contract-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, "apps", "desktop", "scripts");
  const output = path.join(root, "output");
  await mkdir(modules, { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await mkdir(output);
  for (const file of [
    "apps/desktop/scripts/desktop-external-runtime-test.mts",
    "scripts/development-evidence.mts",
  ])
    await copyFile(file, path.join(root, file));
  const consumer = path.join(modules, "consumer.mjs");
  await writeFile(
    consumer,
    `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import path from "node:path";
    assert.throws(() => import.meta.resolve("selenium-webdriver"), { code: "ERR_MODULE_NOT_FOUND" });
    const { createExternalRuntimeFixture, externalFixtureTreeDigest } =
      await import("./desktop-external-runtime-test.mts");
    const fixture = await createExternalRuntimeFixture(process.argv[2]);
    const files = new Map(await Promise.all(["game.exe", "unknown-save.bin"].map(async name =>
      [name, await readFile(path.join(fixture.directory, name))])));
    assert.equal(fixture.port.release.user_prepared["windows-x86-64"].immutable_tree_sha256,
      externalFixtureTreeDigest(files));
    assert.equal(fixture.identities.length, 3);
    console.log("dependency-free fixture contracts passed");
  `,
  );
  const result = spawnSync(process.execPath, [consumer, output], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dependency-free fixture contracts passed/);
});

void test("external runtime qualification is standalone and keeps a source-free inert tree", async (t) => {
  const id = "native-external-runtime-review";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, [
    "desktop",
    "native-dialog",
    "external-runtime-fixture",
  ]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  assert.deepEqual(required(desktopScenarioById.get(id)).platforms, ["win32"]);
  assert.equal(required(desktopScenarioById.get(id)).qualification_only, true);
  for (const platform of ["linux", "darwin"] as const)
    assert.throws(() => resolveDesktopSelection({ scenarios: [id], platform }), /requires Windows/);
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-external-runtime-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await createExternalRuntimeFixture(output);
  const document = object(json(await readFile(fixture.catalogPath, "utf8")));
  const ports = values(document.ports);
  assert.equal(ports.length, 1);
  assert.deepEqual(document.source_catalog, {
    evidence: [],
    identities: [],
    contracts: [],
    validators: [],
  });
  assert.equal(object(ports[0]).source_profile, undefined);
  const spec = object(object(object(object(ports[0]).release).user_prepared)["windows-x86-64"]);
  const files = new Map(
    await Promise.all(
      ["game.exe", "unknown-save.bin"].map(
        async (name: string) => [name, await readFile(path.join(fixture.directory, name))] as const,
      ),
    ),
  );
  assert.equal(spec.immutable_tree_sha256, externalFixtureTreeDigest(files));
  files.set("unknown-save.bin", Buffer.from("different unknown save"));
  assert.notEqual(spec.immutable_tree_sha256, externalFixtureTreeDigest(files));
  assert.equal(fixture.identities.length, 3);
  for (const identity of fixture.identities)
    assert.equal((await fileIdentity(identity.path)).sha256, identity.sha256);
  await assert.rejects(createExternalRuntimeFixture(output), /EEXIST/);
  await assert.rejects(createExternalRuntimeFixture("relative"), /absolute/);
});

void test("external tree hash is ordered, byte-sensitive and refuses unsafe path declarations", () => {
  const first = new Map([
    ["z.bin", Buffer.from("z")],
    ["a.bin", Buffer.from("a")],
  ]);
  assert.equal(
    externalFixtureTreeDigest(first),
    externalFixtureTreeDigest(new Map([...first].reverse())),
  );
  const changed = new Map(first);
  changed.set("a.bin", Buffer.from("aa"));
  assert.notEqual(externalFixtureTreeDigest(first), externalFixtureTreeDigest(changed));
  assert.throws(() => externalFixtureTreeDigest(new Map([["../outside", Buffer.from("x")]])));
});

void test("external picker observation leaves immutable Tauri internals untouched and preserves failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-picker-unmodified-"));
  // The parent retains cleanup ownership even when the controlled child times out.
  t.after(() => rm(root, { recursive: true, force: true }));
  async function observeOriginalPicker(root: string) {
    try {
      for (const refused of [false, true]) {
        const output = path.join(root, refused ? "refused" : "cancelled");
        await mkdir(output);
        const fixture = await createExternalRuntimeFixture(output);
        const original = () => assert.fail("Picker observation must not invoke Tauri internals");
        const internals = Object.freeze({ invoke: original });
        const failure = new Error("original owned helper failure");
        let chosen = 0;
        let selected = 0;
        const document: { activeElement: unknown; elementFromPoint: () => unknown } = {
          activeElement: undefined,
          elementFromPoint: () => identity,
        };
        const identity = {
          closest: () => null,
          getAnimations: () => [],
          focus: () => {
            document.activeElement = identity;
          },
          scrollIntoView: () => {},
          getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 40 }),
          contains: () => false,
          isDisplayed: async () => true,
          isEnabled: async () => true,
          click: async () => {
            selected++;
          },
        };
        const group = {
          getAttribute: async (name: string) => {
            assert.ok(["data-discover-port-ids", "data-discover-matching-port-ids"].includes(name));
            return JSON.stringify([fixture.port.id]);
          },
          findElement: async (locator: { value: string }) => {
            assert.equal(locator.value, ".discover-game-identity");
            return identity;
          },
        };
        const browser = {
          executeScript: async (script: unknown, ...args: unknown[]) => {
            assert.ok(typeof script === "string" || typeof script === "function");
            const body =
              typeof script === "string"
                ? `(function () { ${script} }).apply(undefined, args)`
                : `(${script.toString()})(...args)`;
            return runInNewContext(body, {
              args,
              document,
              window: Object.freeze({ __TAURI_INTERNALS__: internals }),
            });
          },
          wait: async (condition: unknown) => {
            if (typeof condition === "function") {
              const value = await sourceFunction(condition)(browser);
              assert.ok(value, "The real grouped selection wait must settle");
              return value;
            }
            const observation = object(condition);
            if (typeof observation.fn === "function") {
              const value = await sourceFunction(observation.fn)(browser);
              assert.ok(value, "The real native visibility/location wait must settle");
              return value;
            }
            assert.equal(typeof observation.value, "string");
            return true;
          },
          findElements: async (locator: { value: string }) => {
            if (locator.value === ".discover-game[data-discover-port-ids]") return [group];
            assert.equal(
              locator.value,
              `[data-detail-workspace][data-detail-port-id="${fixture.port.id}"]`,
            );
            assert.equal(
              selected,
              1,
              "The exact Discover identity must open before details settle",
            );
            return [{}];
          },
          findElement: (locator: { value: string }) => ({
            click: async () => {
              if (locator.value.includes("Choose game folder")) {
                assert.equal(selected, 1);
                chosen++;
              }
            },
            sendKeys: async () => {},
            isEnabled: async () => true,
          }),
        };
        const pickerContext = {
          browser,
          By: { xpath: (value: string) => ({ value }), id: (value: string) => ({ value }) },
          Key: {
            chord: (...keys: string[]) => keys.join(""),
            CONTROL: "control",
            BACK_SPACE: "backspace",
          },
          until: { elementLocated: (locator: unknown) => locator },
          fixture,
          observePicker: async () => {
            assert.equal(chosen, 1);
            if (refused) throw failure;
            return { cancelled: true };
          },
        };
        // @ts-expect-error This call-order fixture deliberately models only the used driver/locator capabilities.
        const action = externalRuntimePickerObservation(pickerContext);
        if (refused) await assert.rejects(action, (error) => error === failure);
        else assert.equal((await action).cancelled, true);
        assert.equal(internals.invoke, original);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const entry = new URL(
    "../apps/desktop/scripts/desktop-external-runtime-test.mts",
    import.meta.url,
  );
  const program = `
    import path from 'node:path';
    import {mkdir,rm} from 'node:fs/promises';
    import {runInNewContext} from 'node:vm';
    const {isRecord} = await import(new URL('../../../scripts/runtime-values.mts',entry).href);
    const {createExternalRuntimeFixture,externalRuntimePickerObservation} = await import(entry);
    const object = ${object.toString()};
    const sourceFunction = ${sourceFunction.toString()};
    await (${observeOriginalPicker.toString()})(${JSON.stringify(root)});
  `;
  runDesktopModuleFixture(entry, program);
});

void test("external runtime journey retains a failed dispatcher picker phase before later actions", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-picker-phase-failure-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const failure = new Error("Original owned picker phase failed");
  const artifacts: string[] = [];
  const interruptedContext = {
    output,
    By: { xpath: (value: string) => ({ value }) },
    artifacts,
    fixture: await createExternalRuntimeFixture(output),
    pickerObservation: Promise.reject(failure),
    invoke: () => {
      throw new Error("Later native actions must not run after failed picker cancellation");
    },
  };
  await assert.rejects(
    // Failed picker cancellation must abort before the deliberately omitted native/UI capabilities.
    // @ts-expect-error This partial boundary fixture cannot execute later native actions.
    externalRuntimeReviewScenario(interruptedContext),
    (error) => error === failure,
  );
  const reportPath = path.join(output, "external-runtime-review.json");
  assert.deepEqual(artifacts, [reportPath]);
  const report: unknown = json(await readFile(reportPath, "utf8"));
  assert.ok(isRecord(report));
  assert.equal(report.error, String(failure));
  assert.deepEqual(report.steps, []);
});

void test(
  "picker observation refuses stale launch identities and directory input before UI enumeration",
  {
    skip:
      process.platform !== "win32" &&
      "platform: win32; requires Windows PowerShell picker guards; route: ci.yml/windows_storage (windows-storage-4)",
  },
  async (t) => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-picker-identity-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    const script = path
      .resolve("apps/desktop/scripts/native-confirmation.ps1")
      .replaceAll("'", "''");
    await mkdir(path.join(output, "different-owner", "player-owned-runtime"), { recursive: true });
    await mkdir(path.join(output, "unadmitted-name"));
    for (const kind of [
      "stale-time",
      "wrong-image",
      "directory-input",
      "outside-prepared",
      "unadmitted-name",
    ]) {
      const helper = path.join(output, `${kind}.ps1`);
      const extra =
        kind === "directory-input"
          ? "-DirectoryPath $PSScriptRoot"
          : kind === "outside-prepared"
            ? // An admitted basename with the wrong parent reaches the path check,
              // rather than the earlier fixture-name refusal.
              "-PreparedRuntimeDirectory (Join-Path (Join-Path $PSScriptRoot 'different-owner') 'player-owned-runtime')"
            : kind === "unadmitted-name"
              ? "-PreparedRuntimeDirectory (Join-Path $PSScriptRoot 'unadmitted-name')"
              : "";
      await writeFile(
        helper,
        `
$ErrorActionPreference = 'Stop'
$owned = [Diagnostics.Process]::GetCurrentProcess()
$image = $owned.MainModule.FileName
$expectedImage = ${kind === "wrong-image" ? "'C:\\not-the-owned-driver.exe'" : "$image"}
$filetime = ${kind === "stale-time" ? "'1'" : "$owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()"}
function Add-Type { throw 'Rejected picker input must not initialize UI automation.' }
try {
    & '${script}' -DriverProcessId $PID -ApplicationPath $image -ObservePicker -ExpectedDriverPath $expectedImage -ExpectedDriverStartedFiletime $filetime -ObservationPath (Join-Path $PSScriptRoot '${kind}.json') ${extra}
    exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`,
        { flag: "wx" },
      );
      const started = performance.now();
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", helper], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      const phase = result.stderr?.match(/^PORTCOVE_NATIVE_FAILURE (.+)$/mu)?.[1];
      const stage = phase ? object(json(phase)).stage : null;
      t.diagnostic(
        JSON.stringify({
          case: kind,
          elapsed_ms: Math.round(performance.now() - started),
          status: result.status,
          signal: result.signal,
          error_code: errorCode(result.error) ?? null,
          phase: stage,
        }),
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        kind === "directory-input"
          ? /Parameter set cannot be resolved/
          : kind === "outside-prepared"
            ? /Prepared runtime input requires the exact regular owned fixture directory/
            : kind === "unadmitted-name"
              ? /Picker input is not an admitted owned fixture directory/
              : /Captured picker driver identity changed/,
      );
      if (kind !== "directory-input") assert.equal(stage, "picker-preflight");
      await assert.rejects(stat(path.join(output, `${kind}.json`)), /ENOENT/);
    }
  },
);

void test(
  "prepared runtime picker refuses a different directory before obtaining a driver",
  {
    skip:
      process.platform !== "win32" &&
      "platform: win32; requires Windows PowerShell picker guards; route: ci.yml/windows_storage (windows-storage-4)",
  },
  async (t) => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-prepared-input-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    const input = nativePreparedRuntimePicker({
      output,
      application: process.execPath,
      getDriverIdentity: () => {
        throw new Error("Driver must not be observed for rejected input");
      },
      artifacts: [],
    });
    await assert.rejects(
      input("refused-selection", output),
      /Exact owned prepared-runtime directory required/,
    );
  },
);

void test("technical detail geometry accepts stacked or side-by-side rows and rejects overlap", () => {
  assert.equal(
    technicalDetailHasSeparation({ labelRight: 80, valueLeft: 100, labelBottom: 30, valueTop: 10 }),
    true,
  );
  assert.equal(
    technicalDetailHasSeparation({ labelRight: 80, valueLeft: 10, labelBottom: 30, valueTop: 40 }),
    true,
  );
  assert.equal(
    technicalDetailHasSeparation({ labelRight: 80, valueLeft: 10, labelBottom: 30, valueTop: 10 }),
    false,
  );
});

void test("preferences recovery is standalone and preserves a malformed original before repair", async (t) => {
  const id = "native-startup-preferences-recovery";
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.equal(preferencesRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"] as const)
    assert.throws(() => preferencesRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop"]);
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-preferences-recovery-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await preparePreferencesRecoveryFixture(output);
  const original = await readFile(fixture.preferencesBefore);
  assert.throws(() => json(original), SyntaxError);
  assert.deepEqual(await readFile(fixture.preferences), original);
  assert.deepEqual(await readFile(fixture.marker), await readFile(fixture.markerBefore));
  const repaired = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.selectedRoot }),
  );
  await writeFile(fixture.preferences, repaired);
  await assert.rejects(preparePreferencesRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferencesBefore), original);
  assert.deepEqual(await readFile(fixture.preferences), repaired);
});

void test("library switch recovery refuses unsupported hosts and mixed setup before launch", () => {
  const selection = resolveDesktopSelection({ scenarios: ["native-library-switch-recovery"] });
  assert.equal(librarySwitchRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"] as const)
    assert.throws(() => librarySwitchRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() =>
    librarySwitchRecoverySelection({ ...selection, setup_scenarios: ["empty-library"] }, "win32"),
  );
  assert.throws(
    () =>
      resolveDesktopSelection({ scenarios: ["native-library-switch-recovery", "empty-library"] }),
    /standalone/,
  );
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "native-dialog"]);
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-library-switch-recovery"));
  assert.equal(desktopHarnessDeadlineMs(selection), 3 * 60_000);
});

void test("future library fixture has a real SQLite ledger and cannot reseed a saved choice", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-library-switch-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await prepareLibrarySwitchRecoveryFixture(output);
  const bytes = await readFile(fixture.futureDatabase);
  assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
  const database = new DatabaseSync(fixture.futureDatabase, { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare("SELECT version, applied_at FROM schema_migrations")
        .all()
        .map((row) => ({ ...row })),
      [{ version: 999, applied_at: 0 }],
    );
  } finally {
    database.close();
  }
  assert.deepEqual(await readFile(fixture.futureDatabase), bytes);
  assert.equal(
    object(json(await readFile(fixture.preferences, "utf8"))).library_root,
    fixture.currentRoot,
  );
  const recovered = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.healthyRoot }),
  );
  await writeFile(fixture.preferences, recovered);
  await assert.rejects(prepareLibrarySwitchRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferences), recovered);
  assert.deepEqual(await readFile(fixture.futureDatabase), bytes);
  for (const marker of ["currentMarker", "futureMarker"] as const)
    assert.deepEqual(await readFile(fixture[marker]), await readFile(fixture.before[marker]));
});

void test("startup recovery refuses unsupported host and mixed setup before launch", () => {
  const selection = {
    selected_scenarios: ["native-startup-library-recovery"],
    setup_scenarios: [],
  };
  assert.equal(bootstrapRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"] as const)
    assert.throws(() => bootstrapRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() =>
    bootstrapRecoverySelection({ ...selection, setup_scenarios: ["empty-library"] }, "win32"),
  );
  assert.throws(() =>
    bootstrapRecoverySelection(
      { ...selection, selected_scenarios: [...selection.selected_scenarios, "empty-library"] },
      "win32",
    ),
  );
});

void test("startup fixture child cannot inherit case aliases that mask saved selection", () => {
  const inherited = {
    ...process.env,
    PORTCOVE_LIBRARY: "masked-saved-selection",
    Portcove_Library: "masked-mixed-selection",
    portcove_library: "masked-lower-selection",
    PORTCOVE_PREFERENCES: "owned-preferences",
  };
  const environment = bootstrapRecoveryEnvironment(inherited);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({library:process.env.PORTCOVE_LIBRARY,preferences:process.env.PORTCOVE_PREFERENCES}))",
    ],
    { env: environment, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(json(child.stdout), { preferences: "owned-preferences" });
  assert.deepEqual(
    Object.keys(environment).filter((key: string) => key.toUpperCase() === "PORTCOVE_LIBRARY"),
    [],
  );
  assert.equal(inherited.PORTCOVE_LIBRARY, "masked-saved-selection");
  assert.equal(inherited.Portcove_Library, "masked-mixed-selection");
  assert.equal(inherited.portcove_library, "masked-lower-selection");
});

void test("initial saved target is a regular file and reseeding cannot overwrite a recovered choice", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-recovery-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await prepareBootstrapRecoveryFixture(output);
  assert.ok((await stat(fixture.invalidRoot)).isFile());
  assert.ok((await stat(fixture.selectedRoot)).isDirectory());
  const before = await readFile(fixture.preferencesBefore);
  assert.equal(object(json(before)).library_root, fixture.invalidRoot);
  assert.deepEqual(await readFile(fixture.invalidRoot), await readFile(fixture.invalidBefore));
  const recovered = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.selectedRoot }),
  );
  await writeFile(fixture.preferences, recovered);
  await assert.rejects(prepareBootstrapRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferences), recovered);
  assert.deepEqual(await readFile(fixture.preferencesBefore), before);
});

void test("initial startup recovery remains a standalone opt-in native picker route", () => {
  const id = "native-startup-library-recovery";
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "native-dialog"]);
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  assert.equal(desktopHarnessDeadlineMs(selection), 3 * 60_000);
});

void test("cancelled navigation permits only observed GETs and never popup or execution traffic", () => {
  const request = { method: "GET", path: "/untrusted", phase: "navigation-http" };
  assertOwnedBoundaryRequests([]);
  assertOwnedBoundaryRequests([request]);
  for (const invalid of [
    { ...request, method: "POST" },
    { ...request, path: "/untrusted/popup" },
    { ...request, path: "/untrusted/executed-marker" },
    { ...request, path: "/", phase: "frame-csp" },
    { ...request, phase: "main-controls" },
  ])
    assert.throws(() => assertOwnedBoundaryRequests([invalid]));
});

const normalFixtureMainUrl =
  process.platform === "linux" ? "tauri://localhost/" : "http://tauri.localhost/";

void test("owned frame CSP requires a trusted enforced event and removes its frame/listener/timer", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-frame-boundary-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const library = path.resolve("work", "frame-boundary-library");
  const url = normalFixtureMainUrl;
  const valid = {
    isTrusted: true,
    effectiveDirective: "frame-src",
    disposition: "enforce",
    blockedURI: "owned-frame",
    documentURI: url,
    originalPolicy: "default-src 'self'",
  };
  async function run(
    events: readonly (typeof valid)[],
    { changedContext = false, failSetup = false } = {},
  ) {
    const output = await mkdtemp(path.join(outputRoot, "case-"));
    const listeners = new Set<(event: typeof valid) => void>();
    const timers = new Set<() => void>();
    const frames: { isConnected: boolean; src?: string; remove(): void }[] = [];
    let attempts = 0;
    let appended = false;
    const invoke = async (command: string, args?: object | null) => {
      const arguments_ = args == null ? {} : object(args);
      if (
        appended &&
        command === "open_external_url" &&
        arguments_.url === "https://github.com/boburning/portcove"
      )
        throw new Error("Contract fixture stops after frame guard");
      if (command === "get_locale_preference" && appended)
        throw new Error("Contract fixture stops after frame guard");
      if (command === "get_locale_preference") return { ok: true, value: { locale: "en" } };
      if (command === "plugin:window|get_all_windows") return { ok: true, value: ["main"] };
      if (command === "plugin:webview|get_all_webviews")
        return { ok: true, value: [{ window_label: "main", label: "main" }] };
      if (command === "plugin:webview|create_webview_window")
        return {
          ok: false,
          error: "Command plugin:webview|create_webview_window not allowed by ACL",
        };
      if (command === "set_locale_preference") return { ok: true, value: null };
      if (command.startsWith("open_"))
        return {
          ok: false,
          error: {
            code: command === "open_external_url" ? "usage" : "not_found",
            message:
              command === "open_external_url"
                ? "only reviewed project, artwork source and GitHub sign-in links may be opened"
                : "unknown source evidence id: portcove-boundary-unknown-evidence",
          },
        };
      if (command.includes("boundary")) return { ok: false, error: `command ${command} not found` };
      return command === "get_bootstrap_status"
        ? {
            ok: true,
            value: {
              ready: true,
              error: null,
              library_root: library,
              generation: appended && changedContext ? 2 : 1,
              selection: { root: library, source: "environment" },
            },
          }
        : { ok: true, value: { id: "owned-library", root: library } };
    };
    let scriptCalls = 0;
    const browser = {
      getCurrentUrl: async () => url,
      manage: () => ({ setTimeouts: async () => {} }),
      executeScript: async () => (++scriptCalls === 1 ? {} : [url]),
      executeAsyncScript: async (callback: unknown, ...args: unknown[]): Promise<unknown> => {
        assert.ok(typeof callback === "function");
        const attempted = args[0];
        if (attempted === undefined) return {};
        assert.ok(typeof attempted === "string");
        return new Promise((resolve) => {
          const document = {
            createElement: (tag: string) => {
              assert.equal(tag, "iframe");
              const frame = {
                isConnected: false,
                remove() {
                  this.isConnected = false;
                },
              };
              frames.push(frame);
              return frame;
            },
            addEventListener: (type: string, handler: (event: typeof valid) => void) => {
              assert.equal(type, "securitypolicyviolation");
              listeners.add(handler);
            },
            removeEventListener: (type: string, handler: (event: typeof valid) => void) => {
              assert.equal(type, "securitypolicyviolation");
              listeners.delete(handler);
            },
            body: {
              append(frame: { src?: string; isConnected: boolean }) {
                appended = true;
                attempts++;
                assert.equal(frame.src, attempted);
                if (failSetup) throw new Error("Owned fixture append failed");
                frame.isConnected = true;
                for (const event of events)
                  for (const listener of [...listeners]) {
                    const wrongOrigin = new URL(attempted);
                    wrongOrigin.port = String(
                      Number(wrongOrigin.port) === 65535 ? 1 : Number(wrongOrigin.port) + 1,
                    );
                    listener({
                      ...event,
                      blockedURI:
                        event.blockedURI === "owned-frame"
                          ? attempted
                          : event.blockedURI === "wrong-origin"
                            ? wrongOrigin.href
                            : event.blockedURI === "wrong-path"
                              ? new URL("/other", attempted).href
                              : event.blockedURI,
                    });
                  }
                // Advance the fixture's virtual deadline, without a real wait.
                for (const timer of [...timers]) timer();
              },
            },
          };
          runInNewContext(
            `(${callback.toString()})(attempted, done)`,
            {
              URL,
              document,
              attempted,
              done: resolve,
              setTimeout: (handler: () => void, milliseconds: number) => {
                assert.equal(milliseconds, 9000);
                timers.add(handler);
                return handler;
              },
              clearTimeout: (handler: () => void) => timers.delete(handler),
            },
            { timeout: 1000 },
          );
        });
      },
    };
    let error;
    try {
      const boundaryContext = {
        browser,
        invoke,
        library,
        output,
        artifacts: [],
        packageEvidence: { fixture: true },
        externalBrowser: { fixture: true },
      };
      // @ts-expect-error This renderer contract fixture intentionally bypasses package provenance setup.
      await normalPackageBoundaryScenario(boundaryContext);
    } catch (caught) {
      if (
        !(caught instanceof Error) ||
        caught.message !== "Contract fixture stops after frame guard"
      )
        error = caught;
    }
    const observations = object(
      json(await readFile(path.join(output, "normal-package-boundary.json"))),
    );
    assert.equal(attempts, 1);
    assert.equal(frames.length, 1);
    assert.equal(required(frames[0]).isConnected, false);
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
    const csp = object(observations.cspFrame);
    return {
      observations: {
        ...observations,
        cspFrame: {
          attempted: text(csp.attempted),
          before: csp.before,
          after: csp.after,
          refusal: object(csp.refusal),
        },
      },
      error,
    };
  }
  const wrong = [
    { ...valid, isTrusted: false },
    { ...valid, disposition: "report" },
    { ...valid, effectiveDirective: "script-src" },
    { ...valid, blockedURI: "wrong-origin" },
    { ...valid, blockedURI: "wrong-path" },
    { ...valid, blockedURI: "inline" },
  ];
  const positive = await run([...wrong, valid]);
  assert.equal(positive.error, undefined);
  assert.equal(new URL(positive.observations.cspFrame.attempted).hostname, "127.0.0.1");
  assert.equal(new URL(positive.observations.cspFrame.attempted).pathname, "/");
  assert.deepEqual(positive.observations.cspFrame.after, positive.observations.cspFrame.before);
  for (const events of [[], ...wrong.map((event) => [event])]) {
    const rejected = await run(events);
    assert.match(text(object(rejected.error).message), /enforced owned-frame CSP refusal/);
    assert.equal(rejected.observations.cspFrame.refusal.observed, false);
    assert.equal(rejected.observations.cspFrame.refusal.frameRemoved, true);
  }
  assert.match(
    text(object((await run([valid], { changedContext: true })).error).message),
    /preserve main and library context/,
  );
  const setupFailure = await run([], { failSetup: true });
  assert.match(text(object(setupFailure.error).message), /enforced owned-frame CSP refusal/);
  assert.equal(setupFailure.observations.cspFrame.refusal.reason, "frame-setup-failed");
});

void test("reviewed link refusals require guard errors and preserve the ready native context", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-link-boundary-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const library = path.resolve("work", "link-boundary-library");
  const status = {
    ready: true,
    error: null,
    library_root: library,
    generation: 1,
    selection: { root: library, source: "environment" },
  };
  async function run({
    refusal,
    contextChange,
    identityChange,
    identityRoot = library,
    urlChange,
  }: {
    refusal?: unknown;
    contextChange?: Record<string, unknown>;
    identityChange?: Record<string, unknown>;
    identityRoot?: string;
    urlChange?: string;
  } = {}) {
    const output = await mkdtemp(path.join(outputRoot, "case-"));
    const calls: { command: string; args: unknown; afterAttempt?: boolean }[] = [];
    let refused = false;
    const observations: Record<string, unknown> = {};
    const invoke = async (command: string, args?: object | null) => {
      calls.push({ command, args });
      if (command === "set_locale_preference") return { ok: true, value: null };
      if (command === "create_boundary_windows")
        throw new Error("Contract fixture stops after link guards");
      if (command === "get_bootstrap_status")
        return { ok: true, value: { ...status, ...(refused ? contextChange : {}) } };
      if (command === "get_library_identity")
        return {
          ok: true,
          value: { id: "owned-library", root: identityRoot, ...(refused ? identityChange : {}) },
        };
      refused = true;
      return (
        refusal ?? {
          ok: false,
          error: {
            code: command === "open_external_url" ? "usage" : "not_found",
            message:
              command === "open_external_url"
                ? "only reviewed project, artwork source and GitHub sign-in links may be opened"
                : "unknown source evidence id: portcove-boundary-unknown-evidence",
          },
        }
      );
    };
    await normalPackageBoundaryScenario({
      browser: {
        getCurrentUrl: async () => (refused && urlChange) || normalFixtureMainUrl,
        manage: () => ({ setTimeouts: async () => {} }),
        executeScript: async () => ({}),
        executeAsyncScript: async () => ({}),
      },
      invoke,
      library,
      output,
      artifacts: [],
      // @ts-expect-error Renderer refusal fixture deliberately bypasses package provenance setup.
      packageEvidence: { fixture: true },
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "Contract fixture stops after link guards")
        throw error;
    });
    Object.assign(
      observations,
      json(await readFile(path.join(output, "normal-package-boundary.json"))),
    );
    return { calls, observations };
  }
  const { calls, observations } = await run();
  assert.equal(values(observations.reviewedLinkRefusals).length, 2);
  assert.deepEqual(
    calls.filter(({ command }) => command.startsWith("open_")),
    [
      {
        command: "open_external_url",
        args: { url: "https://unreviewed.portcove.invalid/boundary" },
      },
      {
        command: "open_source_evidence",
        args: { evidenceId: "portcove-boundary-unknown-evidence" },
      },
    ],
  );
  for (const refusal of [
    { ok: true, value: null },
    { ok: false, error: "command open_external_url not found" },
    { ok: false, error: { code: "usage" } },
    { ok: false, error: { code: "state", message: "library unavailable" } },
    {
      ok: false,
      error: { code: "unsupported", message: "source evidence requires catalog schema 2" },
    },
  ])
    await assert.rejects(run({ refusal }));
  for (const contextChange of [
    { ready: false },
    { generation: 2 },
    { library_root: path.resolve("work", "other-library") },
    { selection: { root: library, source: "saved" } },
  ])
    await assert.rejects(run({ contextChange }));
  await assert.rejects(run({ identityChange: { id: "other-library" } }));
  await assert.rejects(run({ identityChange: { root: path.resolve("work", "other-library") } }));
  await assert.rejects(run({ urlChange: "https://unreviewed.portcove.invalid/boundary" }));
  if (process.platform === "win32") {
    const namespaced = await run({ identityRoot: path.toNamespacedPath(library) });
    assert.equal(values(namespaced.observations.reviewedLinkRefusals).length, 2);
    assert.ok(
      values(namespaced.observations.reviewedLinkRefusals).every((record) => object(record).after),
    );
    await assert.rejects(
      run({ identityRoot: path.toNamespacedPath(path.resolve("work", "other-library")) }),
    );
  }
});

void test("shipping secondary creation requires ACL refusal and preserves native main state", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "portcove-secondary-boundary-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const library = path.join(parent, "library");
  const command = "plugin:webview|create_webview_window";
  const error = `Command ${command} not allowed by ACL`;
  const request = {
    options: {
      label: "portcove-boundary-secondary",
      url: "index.html",
      title: "Owned denied secondary boundary",
      visible: false,
    },
  };
  const status = {
    ready: true,
    error: null,
    library_root: library,
    generation: 1,
    selection: { root: library, source: "environment" },
  };
  interface Changes {
    before?: Changes;
    throwCreate?: string;
    result?: unknown;
    throwOn?: Record<string, string>;
    bootstrap?: Record<string, unknown>;
    identity?: Record<string, unknown>;
    localeResult?: unknown;
    locale?: unknown;
    windowsResult?: unknown;
    windows?: unknown;
    webviewsResult?: unknown;
    webviews?: unknown;
    url?: string;
  }
  async function run(changes: Changes = {}) {
    const output = await mkdtemp(path.join(parent, "case-"));
    const calls: { command: string; args: unknown; afterAttempt?: boolean }[] = [];
    let attempted = false;
    let secondaryReady = false;
    const state = (): Changes => {
      if (attempted) return changes;
      return secondaryReady ? (changes.before ?? {}) : {};
    };
    const invoke = async (name: string, args?: object | null) => {
      calls.push({ command: name, args, afterAttempt: attempted });
      if (name === command) {
        assert.deepEqual(args, request, "Bind the valid pinned SDK creation options");
        attempted = true;
        if ("throwCreate" in changes && changes.throwCreate) throw new Error(changes.throwCreate);
        return changes.result ?? { ok: false, error };
      }
      const current = state();
      if (current.throwOn?.[name]) throw new Error(required(current.throwOn[name]));
      const replies: Record<string, unknown> = {
        get_bootstrap_status: { ok: true, value: { ...status, ...current.bootstrap } },
        get_library_identity: {
          ok: true,
          value: { id: "owned-library", root: library, ...current.identity },
        },
        get_locale_preference: current.localeResult ?? {
          ok: true,
          value: { locale: current.locale ?? "en" },
        },
        "plugin:window|get_all_windows": current.windowsResult ?? {
          ok: true,
          value: current.windows ?? ["main"],
        },
        "plugin:webview|get_all_webviews": current.webviewsResult ?? {
          ok: true,
          value: current.webviews ?? [{ window_label: "main", label: "main" }],
        },
        set_locale_preference: { ok: true, value: null },
        open_external_url: {
          ok: false,
          error: {
            code: "usage",
            message: "only reviewed project, artwork source and GitHub sign-in links may be opened",
          },
        },
        open_source_evidence: {
          ok: false,
          error: {
            code: "not_found",
            message: "unknown source evidence id: portcove-boundary-unknown-evidence",
          },
        },
      };
      if (Object.hasOwn(replies, name)) return replies[name];
      assert.ok(name.includes("boundary"), `Unexpected fixture command: ${name}`);
      if (name === "recreate_boundary_owner") secondaryReady = true;
      return { ok: false, error: `command ${name} not found` };
    };
    let failure;
    try {
      const boundaryContext = {
        browser: {
          getCurrentUrl: async () => state().url ?? normalFixtureMainUrl,
          manage: () => ({ setTimeouts: async () => {} }),
          executeScript: async (callback: unknown) => {
            assert.ok(typeof callback === "function" || typeof callback === "string");
            if (callback.toString().includes("document.scripts"))
              throw new Error("Contract fixture stops after secondary creation guard");
            return {};
          },
          executeAsyncScript: async () => ({}),
        },
        invoke,
        library,
        output,
        artifacts: [],
        packageEvidence: { fixture: true },
      };
      // @ts-expect-error Renderer secondary-creation fixture deliberately bypasses provenance setup.
      await normalPackageBoundaryScenario(boundaryContext);
    } catch (caught) {
      if (
        !(caught instanceof Error) ||
        caught.message !== "Contract fixture stops after secondary creation guard"
      )
        failure = caught;
    }
    const raw = object(
      json(await readFile(path.join(output, "normal-package-boundary.json"), "utf8")),
    );
    const observations = {
      ...raw,
      secondaryCreation: object(raw.secondaryCreation),
      reviewedLinkRefusals: values(raw.reviewedLinkRefusals),
    };
    return { failure, observations, calls };
  }
  const positive = await run();
  assert.equal(positive.failure, undefined);
  assert.deepEqual(
    positive.calls.filter(({ command: name }) => name === command),
    [{ command, args: request, afterAttempt: false }],
  );
  assert.deepEqual(positive.observations.secondaryCreation.request, { command, args: request });
  assert.deepEqual(positive.observations.secondaryCreation.result, { ok: false, error });
  assert.deepEqual(
    positive.observations.secondaryCreation.after,
    positive.observations.secondaryCreation.before,
  );
  assert.equal(positive.observations.reviewedLinkRefusals.length, 2);
  const wrongLibrary = path.join(parent, "other-library");
  for (const [name, changes] of [
    ["unexpected success", { result: { ok: true, value: null } }],
    [
      "malformed argument error",
      { result: { ok: false, error: "invalid args: missing field label" } },
    ],
    [
      "unknown command",
      { result: { ok: false, error: "command create_webview_window not found" } },
    ],
    [
      "another command ACL",
      { result: { ok: false, error: "Command plugin:webview|unknown not allowed by ACL" } },
    ],
    [
      "debug-only message",
      {
        result: {
          ok: false,
          error:
            "webview.create_webview_window not allowed. Permissions associated with this command: core:webview:allow-create-webview-window",
        },
      },
    ],
    ["generic error", { result: { ok: false, error: "operation failed" } }],
    ["timeout", { throwCreate: "owned IPC timeout" }],
    ["changed generation", { bootstrap: { generation: 2 } }],
    ["changed selection", { bootstrap: { selection: { root: library, source: "saved" } } }],
    ["changed identity", { identity: { id: "other-library" } }],
    ["changed identity root", { identity: { root: wrongLibrary } }],
    ["changed URL", { url: "http://tauri.localhost/other" }],
    ["changed locale", { locale: "fr" }],
    ["unexpected window", { windows: ["main", "portcove-boundary-secondary"] }],
    ["duplicate window", { windows: ["main", "main"] }],
    [
      "unexpected webview",
      {
        webviews: [
          { window_label: "main", label: "main" },
          { window_label: "main", label: "other" },
        ],
      },
    ],
    ["unavailable windows", { windowsResult: { ok: false, error: "inventory unavailable" } }],
    ["malformed webviews", { webviews: ["main"] }],
  ] as const)
    await t.test(name, async () => {
      const result = await run(changes);
      assert.ok(result.failure, `${name} must fail`);
      assert.equal(result.calls.filter(({ command: name }) => name === command).length, 1);
      for (const field of ["context", "locale", "windows", "webviews"])
        assert.ok(
          Object.hasOwn(object(result.observations.secondaryCreation.after), field) ||
            Object.hasOwn(
              object(object(result.observations.secondaryCreation.after).readFailures),
              field,
            ),
        );
      if ("throwCreate" in changes && changes.throwCreate)
        assert.equal(result.observations.secondaryCreation.invocationFailure, changes.throwCreate);
    });
  for (const [name, before] of [
    ["reserved window already exists", { windows: ["main", "portcove-boundary-secondary"] }],
    ["duplicate initial windows", { windows: ["main", "main"] }],
    ["empty initial windows", { windows: [] }],
    ["missing initial window inventory", { windowsResult: { ok: false, error: "unavailable" } }],
    ["malformed initial window inventory", { windows: {} }],
    [
      "extra initial webview",
      {
        webviews: [
          { window_label: "main", label: "main" },
          { window_label: "other", label: "other" },
        ],
      },
    ],
    [
      "duplicate initial webviews",
      {
        webviews: [
          { window_label: "main", label: "main" },
          { window_label: "main", label: "main" },
        ],
      },
    ],
    ["malformed initial webviews", { webviews: ["main"] }],
    ["missing initial webview inventory", { webviewsResult: { ok: false, error: "unavailable" } }],
    ["unready initial context", { bootstrap: { ready: false } }],
    ["initial bootstrap error", { bootstrap: { error: "library unavailable" } }],
    ["wrong initial root", { bootstrap: { library_root: wrongLibrary } }],
    ["wrong initial identity", { identity: { root: wrongLibrary } }],
    ["missing initial locale", { localeResult: { ok: false, error: "unavailable" } }],
  ] as const)
    await t.test(name, async () => {
      const result = await run({ before });
      assert.ok(result.failure, `${name} must fail before creation`);
      assert.equal(result.calls.filter(({ command: name }) => name === command).length, 0);
      assert.ok(result.observations.secondaryCreation.before);
      assert.equal(result.observations.secondaryCreation.result, undefined);
    });
  const collectors = {
    context: "get_bootstrap_status",
    locale: "get_locale_preference",
    windows: "plugin:window|get_all_windows",
    webviews: "plugin:webview|get_all_webviews",
  };
  for (const [field, name] of Object.entries(collectors))
    await t.test(`retains ${field} failure after failed creation`, async () => {
      const message = `owned ${field} read failure`;
      const result = await run({ throwCreate: "owned IPC timeout", throwOn: { [name]: message } });
      assert.ok(result.failure);
      assert.equal(result.observations.secondaryCreation.invocationFailure, "owned IPC timeout");
      assert.equal(
        object(object(result.observations.secondaryCreation.after).readFailures)[field],
        message,
      );
      for (const [survivor, readCommand] of Object.entries(collectors)) {
        assert.ok(result.calls.some((call) => call.command === readCommand && call.afterAttempt));
        if (survivor !== field)
          assert.ok(Object.hasOwn(object(result.observations.secondaryCreation.after), survivor));
      }
    });
});

void test("ordinary package boundary is isolated and rejects stale or substituted evidence", async (t) => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-normal-package-webview-boundary"],
  });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop"]);
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-normal-package-webview-boundary"));
  const work = path.resolve("work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "normal-package-contract-"));
  t.after(async () => {
    assert.equal(path.dirname(root), work);
    await rm(root, { recursive: true });
  });
  await mkdir(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  const configuration = [];
  for (const name of ["tauri.conf.json", "tauri.windows.conf.json", "Cargo.toml"]) {
    const file = path.join(root, "apps/desktop/src-tauri", name);
    await writeFile(file, "owned configuration fixture");
    configuration.push(await fileIdentity(file));
  }
  const installerPath = path.join(root, "installer.exe");
  await writeFile(installerPath, "owned package fixture");
  const installer = await fileIdentity(installerPath);
  const executable = { sha256: "a".repeat(64) };
  const receiptPath = path.join(root, "installer-evidence.json");
  await writeFile(
    receiptPath,
    JSON.stringify({
      phase: "complete",
      details: {
        installer_sha256: installer.sha256,
        installed_executable_sha256: executable.sha256,
        application_responding: true,
        persistent_data_preserved: true,
        managed_files_removed: true,
        registration_removed: true,
        application_exit_code: 0,
      },
    }),
  );
  const manifest: {
    execution_context?: string;
    revision: string;
    build_command: string[];
    qualification_features: string[];
    configuration: FileIdentity[];
    installer: FileIdentity;
    installer_evidence: FileIdentity;
  } = {
    revision: "b".repeat(40),
    build_command: ["pnpm", "--dir", "apps/desktop", "desktop:build", "--bundles", "nsis"],
    qualification_features: [] as string[],
    configuration,
    installer,
    installer_evidence: await fileIdentity(receiptPath),
  };
  const manifestPath = path.join(root, "package.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root);
  const ordinaryBuild = manifest.build_command;
  for (const substituted of [
    ["pnpm", "tauri", "build", "--bundles", "nsis"],
    [...ordinaryBuild, "--features", "native-compatibility-qualification"],
    ordinaryBuild.map((argument) => (argument === "nsis" ? "deb" : argument)),
    ordinaryBuild.map((argument) => (argument === "desktop:build" ? "desktop:dev" : argument)),
  ]) {
    manifest.build_command = substituted;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root),
    );
  }
  manifest.build_command = ordinaryBuild;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, "c".repeat(40), executable, root),
    /source must match/,
  );
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, { sha256: "d".repeat(64) }, root),
  );
  await writeFile(installerPath, "substituted package");
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root),
    /input changed/,
  );
  await writeFile(installerPath, "owned package fixture");
  const originalReceipt = await readFile(receiptPath, "utf8");
  await writeFile(receiptPath, originalReceipt.replace('"complete"', '"failed"'));
  manifest.installer_evidence = await fileIdentity(receiptPath);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root),
  );
  await mkdir(path.join(root, "installed"));
  const installedPath = path.join(root, "installed", "portcove-desktop.exe");
  await writeFile(installedPath, "owned installed executable");
  const installedExecutable = await fileIdentity(installedPath);
  const ready = {
    phase: "current_installed_boundary_ready",
    details: {
      installer_sha256: installer.sha256,
      installed_executable_sha256: installedExecutable.sha256,
      installed_executable_path: installedPath,
      install_root: path.dirname(installedPath),
      registration_path:
        "Microsoft.PowerShell.Core\\Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PortcoveFixture",
      uninstall_registration_count: 1,
      application_responding: true,
      application_exit_code: 0,
      persistent_data_preserved: true,
    },
  };
  manifest.execution_context = "current-installed";
  const bindReady = async (receipt: unknown) => {
    await writeFile(receiptPath, JSON.stringify(receipt));
    manifest.installer_evidence = await fileIdentity(receiptPath);
    await writeFile(manifestPath, JSON.stringify(manifest));
  };
  await bindReady(ready);
  const verified = await verifyNormalPackageEvidence(
    manifestPath,
    manifest.revision,
    installedExecutable,
    root,
  );
  assert.equal(verified.execution_context, "current-installed");
  for (const [field, value] of [
    ["uninstall_registration_count", 0],
    ["uninstall_registration_count", 2],
    [
      "registration_path",
      ready.details.registration_path.replace("HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE"),
    ],
    ["installed_executable_path", path.join(root, "copied.exe")],
    ["install_root", root],
    ["application_responding", false],
    ["application_exit_code", 1],
    ["persistent_data_preserved", false],
  ] as const) {
    await bindReady({ ...ready, details: { ...ready.details, [field]: value } });
    await assert.rejects(
      verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
      `${field} must refuse current-installed credit`,
    );
  }
  await bindReady({ ...ready, phase: "complete" });
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
    "Post-uninstall evidence must not claim a current installation",
  );
  await bindReady(ready);
  await writeFile(installedPath, "changed after installation");
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
    "Changed installed bytes must fail even when the manifest still matches",
  );
});

void test("desktop scenario catalog is nonempty, unique, and fully profiled", () => {
  assert.ok(DESKTOP_SCENARIOS.length > 0);
  assert.equal(new Set(DESKTOP_SCENARIOS.map((item) => item.id)).size, DESKTOP_SCENARIOS.length);
  for (const [profile, ids] of Object.entries(DESKTOP_PROFILES)) {
    assert.ok(ids.length > 0, profile);
    assert.equal(new Set(ids).size, ids.length, profile);
    for (const id of ids)
      assert.ok(
        DESKTOP_SCENARIOS.some((item) => item.id === id),
        `${profile}: ${id}`,
      );
  }
  for (const item of catalogReport()) {
    if (item.id === "native-repeated-library-reload" || item.qualification_only) continue;
    assert.ok(item.profiles.length > 0, item.id);
    for (const dependency of item.dependencies) {
      const dependencyIndex = DESKTOP_SCENARIOS.findIndex(
        (candidate) => candidate.id === dependency,
      );
      const itemIndex = DESKTOP_SCENARIOS.findIndex((candidate) => candidate.id === item.id);
      assert.ok(dependencyIndex >= 0, `${item.id}: missing dependency ${dependency}`);
      assert.ok(dependencyIndex < itemIndex, `${item.id}: dependency must execute first`);
      assert.equal(required(DESKTOP_SCENARIOS[dependencyIndex]).runnable, true, dependency);
    }
  }
});

void test("smoke includes isolated install cancellation and committed-refresh recovery", () => {
  const selection = resolveDesktopSelection();
  assert.equal(selection.profile, "smoke");
  assert.ok(selection.selected_scenarios.includes("keyboard-layout"));
  assert.ok(selection.selected_scenarios.includes("install-progress-cancellation"));
  assert.ok(selection.selected_scenarios.includes("install-commit-refresh-recovery"));
  assert.ok(selection.prerequisites.includes("install-fixture"));
  assert.deepEqual(selection.known_gaps, []);
});

void test("live default-cover observation remains opt-in without fixtures or offline profiles", () => {
  for (const id of ["native-default-cover-display", "native-default-cover-cache-conditions"]) {
    for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
    const selection = resolveDesktopSelection({ scenarios: [id] });
    assert.deepEqual(selection.selected_scenarios, [id]);
    assert.deepEqual(selection.setup_scenarios, []);
    assert.deepEqual(selection.prerequisites, ["desktop"]);
    assert.ok(desktopHarnessDeadlineMs(selection) > 180_000);
  }
});

void test("exact selections are deduplicated and returned in catalog order", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["accessibility", "keyboard-layout", "accessibility"],
  });
  assert.equal(selection.profile, null);
  assert.deepEqual(selection.selected_scenarios, ["keyboard-layout", "accessibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
});

void test("signed artwork correction is an isolated opt-in consumer proof", () => {
  const id = "native-artwork-catalog-correction";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture", "native-dialog"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});

void test("design compatibility stays exact-selection-only and requests its isolated fixture", () => {
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-design-system-compatibility"));
  const selection = resolveDesktopSelection({
    scenarios: ["native-design-system-compatibility"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-design-system-compatibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("design-compatibility-fixture"));
});

void test("live host interruption selects its own fixture without synthetic recovery setup", () => {
  const id = "native-host-interrupted-preparation";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture"]);
  assert.ok(selection.host_resources.includes("native-desktop"));
});

void test("minimized live preparation is one opt-in bounded Windows scenario", () => {
  const id = "native-minimized-preparation-continuity";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture"]);
  assert.ok(selection.host_resources.includes("native-desktop"));
  assert.ok(selection.host_resources.includes("keyboard-pointer"));
  assert.deepEqual(required(desktopScenarioById.get(id)).platforms, ["win32"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});

void test("ordinary preparation close stays isolated from forced and minimized cases", () => {
  const id = "native-closed-preparation-recovery";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture"]);
  assert.deepEqual(required(desktopScenarioById.get(id)).platforms, ["win32"]);
  assert.equal(required(desktopScenarioById.get(id)).qualification_only, true);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "native-host-interrupted-preparation"] }),
    /one exact standalone scenario/,
  );
});

void test("replacement identity failure cannot reuse the former host's exit receipt", () => {
  const session = new OwnedNativeSession();
  session.driver = { pid: 1, path: "C:\\fixture\\former-driver.exe", started_filetime: "100" };
  session.inventory = "former-host-inventory";
  session.cleanup = {
    stopped: { method: "observed-child-exit", exit_code: 0 },
    exited: { observed_processes: 3, exited_at: "2026-10-17T00:00:00Z", wait_ms: 1 },
    snapshot: "former-host-inventory",
  };
  const previous = session.requireQuiescence();
  session.beginLaunch(); // Called before spawning the replacement.
  // Spawn succeeded; its subsequent identity capture failed.
  assert.equal(session.cleanup, undefined, "Final cleanup cannot take an old-success shortcut");
  assert.equal(session.inventory, undefined);
  assert.throws(() => session.requireQuiescence(), /Current owned launch identity/);
  assert.equal(previous.exited.observed_processes, 3, "Former receipt stays preserved separately");
  session.driver = { pid: 2, path: "C:\\fixture\\replacement-driver.exe", started_filetime: "200" };
  assert.throws(() => session.requireQuiescence(), /Current owned exit inventory/);
  session.inventory = "replacement-host-inventory";
  assert.throws(() => session.requireQuiescence(), /Positive current owned/);
  session.cleanup = {
    stopped: { method: "observed-child-exit", exit_code: 0 },
    exited: { observed_processes: 4, exited_at: "2026-10-17T00:00:01Z", wait_ms: 1 },
    snapshot: "replacement-host-inventory",
  };
  assert.equal(session.requireQuiescence().exited.observed_processes, 4);
});

void test("native resource release requires current positive exit after any launch attempt", async () => {
  for (const state of [
    "pristine",
    "no-identity",
    "no-inventory",
    "no-exit",
    "positive",
    "replacement",
  ]) {
    const session = new OwnedNativeSession();
    const calls: string[] = [];
    if (state !== "pristine") session.beginLaunch();
    if (!["pristine", "no-identity"].includes(state))
      session.driver = { pid: 2, path: "C:\\fixture\\driver.exe", started_filetime: "200" };
    if (["no-exit", "positive", "replacement"].includes(state)) session.inventory = "current.json";
    if (["positive", "replacement"].includes(state))
      session.cleanup = {
        stopped: { method: "observed-child-exit", exit_code: 0 },
        exited: { observed_processes: 4, exited_at: "2026-10-20T00:00:00Z", wait_ms: 1 },
        snapshot: "current.json",
      };
    if (state === "replacement") session.beginLaunch();
    const release = session.releaseResources({
      closeFixtures: async () => {
        calls.push("close");
      },
      releaseLock: async () => {
        calls.push("release");
      },
    });
    if (state === "pristine" || state === "positive") {
      await release;
      assert.deepEqual(calls, ["close", "release"], state);
    } else {
      await assert.rejects(release, /Current owned|Positive current owned/);
      assert.deepEqual(calls, [], state);
    }
  }
});

void test("native resource release waits for fixture teardown and preserves teardown failures", async () => {
  const session = new OwnedNativeSession();
  const calls: string[] = [];
  const gate = Promise.withResolvers<void>();
  const failure = new Error("fixture teardown failed");
  const release = session.releaseResources({
    closeFixtures: async () => {
      calls.push("close");
      await gate.promise;
    },
    releaseLock: async () => {
      calls.push("release");
    },
  });
  assert.deepEqual(calls, ["close"]);
  gate.reject(failure);
  await assert.rejects(release, (error) => error === failure);
  assert.deepEqual(calls, ["close"]);
});

void test("focused lifecycle selection resolves setup without claiming it", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-installed-game-removal"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-installed-game-removal"]);
  assert.deepEqual(selection.setup_scenarios, [
    "native-preparation-review-and-play",
    "native-reviewed-backup-restore-and-delete",
  ]);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
});

void test("fixture-only reviews select without first-play while continuity keeps its setup", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-steam-entry-add-and-remove"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-steam-entry-add-and-remove"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.prerequisites.includes("steam-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const id of ["native-game-update-review", "native-reviewed-backup-restore-and-delete"])
    assert.deepEqual(resolveDesktopSelection({ scenarios: [id] }).setup_scenarios, [], id);
  assert.deepEqual(
    resolveDesktopSelection({ scenarios: ["native-game-return-continuity"] }).setup_scenarios,
    ["native-preparation-review-and-play"],
  );
  assert.ok(
    resolveDesktopSelection({ profile: "full" }).selected_scenarios.includes(
      "native-preparation-review-and-play",
    ),
  );
});

void test("staged native composition installs its isolated fixture before review", () => {
  const selection = resolveDesktopSelection({ scenarios: ["native-staged-update-composition"] });
  assert.deepEqual(selection.selected_scenarios, ["native-staged-update-composition"]);
  assert.deepEqual(selection.setup_scenarios, ["install-commit-refresh-recovery"]);
  assert.ok(selection.prerequisites.includes("install-fixture"));
});

void test("startup network diagnostics are standalone and never enter ordinary acceptance profiles", () => {
  const id = "native-startup-network-diagnostic";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  assert.deepEqual(required(catalogReport().find((item) => item.id === id)).profiles, []);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "native-error-recovery"] }),
    /standalone/,
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id], platform: "linux" }),
    /requires Windows/,
  );
});

void test("diagnostic reply drops credential-shaped data even in summary and success payload", async () => {
  const secret = "Bearer private-token";
  const replies = [
    [{ ok: true, value: { token: secret } }, { ok: true }],
    [
      {
        ok: false,
        error: {
          code: "network",
          message: secret,
          details: { token: secret },
          presentation: { summary: secret },
          context: secret,
        },
      },
      { ok: false, code: "network" },
    ],
    [
      { ok: false, error: { code: secret } },
      { ok: false, code: "unknown" },
    ],
    [{}, undefined],
  ];
  for (const [reply, expected] of replies) {
    const commands: string[] = [];
    const report = await observeStartupNetwork({
      invoke: async (command) => {
        commands.push(command);
        if (command === "get_bootstrap_status")
          return {
            ok: true,
            value: { ready: true, error: null, generation: 1, library_root: "owned-library" },
          };
        if (command === "get_library_identity")
          return { ok: true, value: { id: "owned-id", root: "owned-library" } };
        assert.equal(command, "get_github_auth_status");
        return reply;
      },
      readAlerts: async () => 1,
    });
    assert.deepEqual(report.auth_status, expected);
    assert.equal(report.completed, expected !== undefined);
    assert.equal(report.explicit_auth_calls, 1);
    assert.equal(commands.filter((command) => command === "get_github_auth_status").length, 1);
    if (expected === undefined) assert.equal(report.coverage_failure, "explicit-auth-status");
    else {
      assert.equal(report.before_alert_count, 1);
      assert.equal(report.after_alert_count, 1);
      assert.equal(required(report.library).identity.id, "owned-id");
    }
    assert.doesNotMatch(JSON.stringify(report), /Bearer|private-token/);
  }
});

void test("current failed network observation is complete without retry or library change", async () => {
  const commands: string[] = [];
  const bootstrap = { ready: true, error: null, generation: 1, library_root: "owned-library" };
  const report = await observeStartupNetwork({
    invoke: async (command) => {
      commands.push(command);
      if (command === "get_bootstrap_status") return { ok: true, value: bootstrap };
      if (command === "get_library_identity")
        return { ok: true, value: { id: "owned-id", root: "owned-library" } };
      return { ok: false, error: { code: "network", message: "private diagnostic" } };
    },
    readAlerts: async () => 1,
  });
  assert.equal(report.completed, true);
  assert.equal(report.explicit_auth_calls, 1);
  assert.deepEqual(report.auth_status, { ok: false, code: "network" });
  assert.equal(commands.filter((command) => command === "get_github_auth_status").length, 1);
  assert.equal(
    commands.some((command) => /install|token|logout/.test(command)),
    false,
  );
  assert.doesNotMatch(JSON.stringify(report), /private diagnostic/);
});

void test("transport failure retains only coverage phase and does not retry", async () => {
  let calls = 0;
  const report = await observeStartupNetwork({
    invoke: async () => {
      calls++;
      throw new Error("Bearer secret");
    },
    readAlerts: async () => 0,
  });
  assert.equal(report.completed, false);
  assert.equal(report.explicit_auth_calls, 0);
  assert.equal(report.coverage_failure, "before-library");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(report), /Bearer|secret/);
});

void test("diagnostic refuses a changed library after its one explicit read", async () => {
  let reads = 0;
  const report = await observeStartupNetwork({
    invoke: async (command) => {
      if (command === "get_bootstrap_status")
        return {
          ok: true,
          value: { ready: true, error: null, generation: ++reads, library_root: "owned-library" },
        };
      if (command === "get_library_identity")
        return { ok: true, value: { id: "owned-id", root: "owned-library" } };
      return { ok: true, value: { login: "private-login" } };
    },
    readAlerts: async () => 0,
  });
  assert.equal(report.completed, false);
  assert.equal(report.coverage_failure, "after-library");
  assert.equal(report.explicit_auth_calls, 1);
  assert.doesNotMatch(JSON.stringify(report), /private-login/);
});

void test("missing Steam review context fails without loading Selenium", () => {
  const context = {
    browser: {},
    invoke: async () => {},
    scenario: async () => {},
    output: "<negative-fixture>",
    artifacts: [],
    command: () => {},
    seed: async () => {},
    confirmNative: async () => {},
  };
  assert.throws(
    () => assertSteamEntryContext(context),
    /Steam review scenario requires context\.open/,
  );
});

void test("selection rejects ambiguity, unknown IDs, and invalid reload requests", () => {
  assert.throws(
    () => resolveDesktopSelection({ profile: "smoke", scenarios: ["accessibility"] }),
    /cannot be combined/,
  );
  assert.throws(() => resolveDesktopSelection({ profile: "unknown" }), /Unknown desktop profile/);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["missing"] }),
    /Unknown desktop scenario/,
  );
  const install = resolveDesktopSelection({ scenarios: ["install-progress-cancellation"] });
  assert.deepEqual(install.selected_scenarios, ["install-progress-cancellation"]);
  assert.ok(install.prerequisites.includes("install-fixture"));
  const refresh = resolveDesktopSelection({ scenarios: ["install-commit-refresh-recovery"] });
  assert.deepEqual(refresh.selected_scenarios, ["install-commit-refresh-recovery"]);
  assert.deepEqual(refresh.setup_scenarios, []);
  assert.ok(refresh.prerequisites.includes("install-fixture"));
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["native-repeated-library-reload"] }),
    /requires --reload-cycles/,
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["accessibility"], reloadCycles: 2 }),
    /requires --scenario/,
  );
});

void test("reload is opt-in for restart and full profiles", () => {
  assert.ok(
    !resolveDesktopSelection({ profile: "restart" }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
  assert.ok(
    resolveDesktopSelection({ profile: "restart", reloadCycles: 3 }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
});

void test("large lifecycle profiles receive a bounded profile-scale watchdog", () => {
  assert.equal(
    desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "presentation" })),
    180_000,
  );
  assert.equal(
    desktopHarnessDeadlineMs(
      resolveDesktopSelection({ scenarios: ["native-library-move-invalidates-prior-reviews"] }),
    ),
    300_000,
  );
  const handoff = resolveDesktopSelection({ scenarios: ["native-contextual-cli-handoff"] });
  assert.ok(handoff.setup_scenarios.includes("native-library-move-invalidates-prior-reviews"));
  assert.equal(desktopHarnessDeadlineMs(handoff), 300_000);
  assert.equal(desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "full" })), 1_200_000);
});

void test("isolated reviewed backup chains retain the finite lifecycle allowance", () => {
  for (const scenarios of [
    ["native-reviewed-backup-restore-and-delete"],
    ["native-game-return-continuity", "native-reviewed-backup-restore-and-delete"],
    ["native-reviewed-installed-game-removal"],
    [
      "native-interrupted-preparation-recovery",
      "native-reviewed-steam-entry-add-and-remove",
      "native-reviewed-steam-batch-add",
      "native-reviewed-installed-game-removal",
      "native-reviewed-source-reference-removal",
    ],
  ]) {
    assert.equal(desktopHarnessDeadlineMs(resolveDesktopSelection({ scenarios })), 600_000);
  }
  assert.equal(
    desktopHarnessDeadlineMs(
      resolveDesktopSelection({ scenarios: ["native-game-return-continuity"] }),
    ),
    180_000,
  );
});

void test("backup success-focus acceptance is isolated and exact-selection-only", () => {
  const id = "native-backup-delete-focus";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture", "native-dialog"]);
  assert.deepEqual(selection.host_resources, [
    "native-desktop",
    "keyboard-pointer",
    "native-dialog",
  ]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});

for (const id of ["native-late-listener-disposal", "native-rejected-listener-registration"])
  void test(`${id} remains standalone and outside ordinary profiles`, () => {
    const selected = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
    assert.deepEqual(selected.selected_scenarios, [id]);
    assert.deepEqual(selected.setup_scenarios, []);
    assert.equal(desktopScenarioById.get(id)?.qualification_only, true);
    for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
    assert.throws(
      () => resolveDesktopSelection({ scenarios: [id, "empty-library"], platform: "win32" }),
      /standalone/,
    );
    assert.throws(
      () => resolveDesktopSelection({ scenarios: [id], platform: "linux" }),
      /Windows|win32/,
    );
  });

void test("saved-folder selected setup stays standalone and opt-in", () => {
  const id = "native-saved-folder-selected-setup";
  const selection = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "install-fixture", "owned-fixture"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
  for (const profile of ["smoke", "full"])
    assert.ok(
      !resolveDesktopSelection({ profile, platform: "win32" }).selected_scenarios.includes(id),
    );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id, "keyboard-layout"], platform: "win32" }),
    /standalone/,
  );
  assert.deepEqual(
    resolveDesktopSelection({ scenarios: [id], platform: "linux" }).selected_scenarios,
    [id],
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id], platform: "darwin" }),
    /Windows or Linux/,
  );
});

void test("selected setup completion remains a separate Windows/Linux opt-in with ordinary install prerequisites", () => {
  const id = "native-selected-setup-completion";
  const selected = resolveDesktopSelection({ scenarios: [id], platform: "win32" });
  assert.deepEqual(selected.selected_scenarios, [id]);
  assert.deepEqual(selected.setup_scenarios, []);
  assert.deepEqual(selected.prerequisites, ["desktop", "install-fixture", "owned-fixture"]);
  assert.deepEqual(selected.host_resources, ["native-desktop", "keyboard-pointer"]);
  assert.equal(required(desktopScenarioById.get(id)).qualification_only, true);
  assert.equal(
    required(desktopScenarioById.get(id)).source,
    "desktop-selected-setup-completion-test.mts",
  );
  assert.equal(desktopHarnessDeadlineMs(selected), 180_000);
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  assert.throws(
    () =>
      resolveDesktopSelection({
        scenarios: [id, "native-saved-folder-selected-setup"],
        platform: "win32",
      }),
    /standalone/,
  );
  assert.deepEqual(
    resolveDesktopSelection({ scenarios: [id], platform: "linux" }).selected_scenarios,
    [id],
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: [id], platform: "darwin" }),
    /Windows or Linux/,
  );
});

async function disabledSourceReviewBehavior(
  subject: (browser: unknown, candidate: () => unknown) => Promise<unknown>,
) {
  const rejection = new Error("Original enabled-state read failed");
  for (const enabled of [true, false, rejection]) {
    let reads = 0;
    const action = subject(
      {
        findElement(profile: string) {
          assert.equal(profile, "inert-profile");
          return {
            findElement(selector: string) {
              assert.equal(selector, "[data-candidate-review]");
              return {
                async isEnabled() {
                  reads++;
                  if (enabled === rejection) throw rejection;
                  return enabled;
                },
              };
            },
          };
        },
        async wait(predicate: () => unknown, timeout: number, message: string) {
          assert.equal(timeout, 5_000);
          assert.equal(
            message,
            "Selected setup: stale review disabled after unavailable-root refresh",
          );
          assert.equal(await predicate(), !enabled);
        },
      },
      () => "inert-profile",
    );
    if (enabled === rejection)
      await assert.rejects(Promise.resolve(action), (error: unknown) => error === rejection);
    else await action;
    assert.equal(reads, 1);
  }
}

void test("unavailable-root wait observes enabled state and preserves read rejection", () => {
  const entry = new URL("../apps/desktop/scripts/desktop-source-dialog-test.mts", import.meta.url);
  const program = `
    mock.module('selenium-webdriver', {namedExports:{By:{css:value=>value},Key:{},until:{elementLocated:value=>value}}});
    const {waitForDisabledSourceReview}=await import(entry);
    await (${String(disabledSourceReviewBehavior)})(waitForDisabledSourceReview);
  `;
  runDesktopModuleFixture(entry, program);
  runDesktopModuleFixture(entry, program, {
    exportName: "waitForDisabledSourceReview",
    variant: "aliased",
  });
  assert.throws(() =>
    runDesktopModuleFixture(entry, program, {
      exportName: "waitForDisabledSourceReview",
      variant: "wrong-export",
    }),
  );
});

void test("selected setup identities admit both replacements only in the opt-in catalog", async (t) => {
  const root = path.resolve(import.meta.dirname, "..");
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-selected-setup-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await createInstallFixture({
    root,
    output,
    sourceJourney: true,
    revision: "a".repeat(40),
  });
  t.after(() => fixture.close());
  const catalog = json(await readFile(fixture.catalogPath, "utf8"));
  const owned = required(fixture.sourceJourney);
  assert.equal(owned.game.length, owned.replacement.length);
  assert.notDeepEqual(owned.game, owned.replacement);
  for (const [name, original] of [
    ["gamePath", "gameBefore"],
    ["biosPath", "biosBefore"],
  ] as const)
    assert.deepEqual(await readFile(owned[name]), await readFile(owned[original]));
  const sourceCatalog = object(object(catalog).source_catalog);
  const identities = values(sourceCatalog.identities)
    .map(object)
    .filter((item) => owned.profiles.includes(text(item.id)));
  assert.deepEqual(
    identities.map((item) => values(item.variants).length),
    [2, 1],
  );
  const expectedHashes = await Promise.all(
    [owned.gameBefore, owned.gameReplacement].map(
      async (file) => (await fileIdentity(file)).sha256,
    ),
  );
  assert.deepEqual(
    values(required(identities[0]).variants).map(
      (item) =>
        object(values(object(values(object(item).representations)[0]).identities)[0]).sha256,
    ),
    expectedHashes,
  );
  for (const port of [fixture.port, fixture.refreshPort]) {
    const contract = required(
      values(sourceCatalog.contracts)
        .map(object)
        .find((item) => item.port_id === port.id && item.role === "game"),
    );
    assert.deepEqual(contract.supported_variant_ids, ["inert-0", "inert-1"]);
    assert.equal(contract.admission_mode, "enforced");
    assert.ok(text(contract.immutable_review_url).includes("a".repeat(40)));
    for (const requirement of values(object(port.presentation).source_requirements).map(object)) {
      const sourceContract = required(
        values(sourceCatalog.contracts)
          .map(object)
          .find((item) => item.port_id === port.id && item.role === requirement.role),
      );
      assert.equal(sourceContract.admission_mode, "enforced");
      assert.equal(sourceContract.validator_contract_id, null);
      assert.equal(requirement.verification, "catalog-identity");
    }
  }
  assert.equal(fixture.port.adapter, "libultraship-portable");
  assert.equal(fixture.refreshPort.adapter, "psx-recomp-managed");
  assert.equal(fixture.refreshPort.bios_source_profile, owned.profiles[1]);
  assert.equal(fixture.requests.length, 0);
  const ordinaryOutput = await mkdtemp(path.join(os.tmpdir(), "portcove-ordinary-install-"));
  t.after(() => rm(ordinaryOutput, { recursive: true, force: true }));
  const ordinary = await createInstallFixture({ root, output: ordinaryOutput });
  t.after(() => ordinary.close());
  assert.equal(ordinary.sourceJourney, null);
  assert.equal(ordinary.port.source_profile, undefined);
  assert.equal(ordinary.refreshPort.bios_source_profile, undefined);
  const original = json(
    await readFile(path.join(root, "crates/portcove-core/catalog/catalog.json"), "utf8"),
  );
  const ordinaryCatalog = json(await readFile(ordinary.catalogPath, "utf8"));
  assert.deepEqual(object(ordinaryCatalog).source_catalog, object(original).source_catalog);
});
void test("known native fixture conflicts refuse before launch, including transitive prerequisites", () => {
  for (const scenarios of [
    ["native-staged-update-composition", "native-preparation-review-and-play"],
    ["native-staged-update-composition", "native-ready-detail-composition"],
    ["native-library-layout", "native-preparation-cancellation"],
    ["native-library-layout", "native-interrupted-preparation-recovery"],
  ]) {
    assert.throws(() => resolveDesktopSelection({ scenarios }), /separate fresh libraries/);
  }
  for (const scenario of ["native-staged-update-composition", "native-library-layout"]) {
    assert.ok(
      resolveDesktopSelection({ scenarios: [scenario] }).selected_scenarios.includes(scenario),
    );
  }
  assert.ok(resolveDesktopSelection({ profile: "full" }).selected_scenarios.length > 0);
});

import "../apps/desktop/scripts/desktop-qualification-history.native.test.mts";
import "../apps/desktop/scripts/desktop-harness.native.test.mts";
import "../apps/desktop/scripts/desktop-native-observations.native.test.mts";
import "../apps/desktop/scripts/desktop-webview-boundary.native.test.mts";
import "../apps/desktop/scripts/desktop-windows-update.native.test.mts";
import "../apps/desktop/scripts/desktop-macos-installed-update.native.test.mts";
import "../apps/desktop/scripts/desktop-appimage-update.native.test.mts";
import "../apps/desktop/scripts/desktop-application-update-journey.native.test.mts";
import "../apps/desktop/scripts/desktop-windows-public-update.native.test.mts";
import "../apps/desktop/scripts/desktop-readiness.native.test.mts";

import "../apps/desktop/scripts/desktop-default-cover.native.test.mts";
import "../apps/desktop/scripts/desktop-workspace-refresh.native.test.mts";
import "../apps/desktop/scripts/desktop-artwork-correction.native.test.mts";
import "../apps/desktop/scripts/desktop-artwork.native.test.mts";
import "../apps/desktop/scripts/desktop-bootstrap-recovery.native.test.mts";
import "../apps/desktop/scripts/desktop-install.native.test.mts";
import "../apps/desktop/scripts/desktop-staged-layout.native.test.mts";
import "../apps/desktop/scripts/desktop-reload.native.test.mts";
