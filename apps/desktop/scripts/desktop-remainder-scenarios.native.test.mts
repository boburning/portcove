import assert from "node:assert/strict";
import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { runTypeScriptInNewContext as runInNewContext } from "../../../scripts/test-source.mts";
import { readFile } from "node:fs/promises";
import { observeDesktopScenario } from "./desktop-scenario-outcomes.mts";

function callable(value: unknown) {
  assert.equal(typeof value, "function");
  return (...args: unknown[]): unknown =>
    Reflect.apply(value as (...args: unknown[]) => unknown, undefined, args);
}

void test("Windows reload readiness requires Library content beyond the shell", () => {
  runDesktopModuleFixture(
    new URL("./desktop-preparation-recovery-test.mts", import.meta.url),
    `
    const {observeLibraryReloadReadiness}=await import(entry);
    const {runInNewContext}=await import('node:vm');
    for(const [loading,card,expected] of [[true,false,false],[true,true,false],[false,false,false],[false,true,true]]) {
      const document={querySelector:selector=>selector==='.loading-state'?(loading?{}:null):(card?{}:null)};
      assert.equal(runInNewContext('('+String(observeLibraryReloadReadiness)+')()', {document}),expected);
    }
  `,
  );
});

void test("copy readback waits for actual dismissal with a bounded named consent stage", () => {
  runDesktopModuleFixture(
    new URL("./desktop-adoption-review-test.mts", import.meta.url),
    `
    const {waitForCopyReadback}=await import(entry);
    const dialog={using:'css selector',value:'[aria-labelledby="adopt-title"]'};
    let pending=true;
    const browser={
      findElements:async value=>{assert.equal(value,dialog);return pending?[{}]:[];},
      wait:async(probe,budget,message)=>{
        assert.equal(budget,60000);assert.match(message,/Ambiguous native cancellation/);
        assert.equal(await probe(),false);pending=false;assert.equal(await probe(),true);
      },
    };
    await waitForCopyReadback(browser,dialog,'Ambiguous native cancellation');
    const primary=new Error('Readback remained pending');
    browser.wait=async()=>{throw primary;};
    await assert.rejects(waitForCopyReadback(browser,dialog,'Confirmed copy'),error=>error===primary);
  `,
  );
});

void test("owned preparation failure joins worker exit before accepting read-only quiescence", () => {
  runDesktopModuleFixture(
    new URL("./desktop-preparation-recovery-test.mts", import.meta.url),
    `
    const {joinOwnedPreparationAfterFailure}=await import(entry);
    const running={id:'owned-op',operation:'prepare',target_kind:'port',target_id:'owned-port',
      status:'running',finished_at:null,cancellation:{requested:false,phase:'preparing'}};
    const preview={operation_id:'owned-op',port_id:'owned-port',original_install_path:'/owned/install'};
    const report={operation_id:'owned-op',port_id:'owned-port'};
    let current=running,cancels=0,proven=false,finished=false;
    const waiting=Promise.withResolvers(),exit=Promise.withResolvers();
    const join=joinOwnedPreparationAfterFailure(report,'/owned/install',{
      read:async()=>current,
      cancel:async()=>{cancels++;return {requested:true,phase:'preparing'};},
      previewQuiescence:async()=>{assert.equal(finished,true);proven=true;return preview;},
      wait:async(probe,budget)=>{
        assert(budget>0&&budget<=60000);assert.equal(await probe(),false);
        waiting.resolve();await exit.promise;assert.equal(await probe(),true);
      },
    });
    let settled=false;join.then(()=>{settled=true;});
    await waiting.promise;
    assert.equal(cancels,1);assert.equal(settled,false);assert.equal(proven,false);
    finished=true;current={...running,status:'cancelled',finished_at:1};exit.resolve();await join;
    assert.equal(report.joined,true);assert.equal(report.terminal.status,'cancelled');
    assert.equal(report.quiescence,preview);assert.equal(proven,true);
  `,
  );
});

void test("owned failure settlement refuses foreign identity and uncertain quiescence without a weaker cleanup", () => {
  runDesktopModuleFixture(
    new URL("./desktop-preparation-recovery-test.mts", import.meta.url),
    `
    const {joinOwnedPreparationAfterFailure}=await import(entry);
    const row={id:'owned-op',operation:'prepare',target_kind:'port',target_id:'owned-port',status:'cancelled',finished_at:1};
    for(const changed of [{id:'foreign'}, {target_id:'foreign'}, {operation:'install'}, {target_kind:'source'}]) {
      let actions=0;
      await assert.rejects(joinOwnedPreparationAfterFailure({operation_id:'owned-op',port_id:'owned-port'},'/owned/install',{
        read:async()=>({...row,...changed}),cancel:async()=>{actions++;},
        previewQuiescence:async()=>{actions++;},wait:async()=>{actions++;},
      }));
      assert.equal(actions,0);
    }
    const report={operation_id:'owned-op',port_id:'owned-port'};
    const primary=new Error('Process quiescence is not proven');
    await assert.rejects(joinOwnedPreparationAfterFailure(report,'/owned/install',{
      read:async()=>row,cancel:async()=>assert.fail('Terminal work must not be cancelled again'),
      wait:async probe=>assert.equal(await probe(),true),previewQuiescence:async()=>{throw primary;},
    }),error=>error===primary);
    assert.notEqual(report.joined,true);
    for(const changed of [{operation_id:'foreign'}, {port_id:'foreign'}, {original_install_path:'/foreign'}]) {
      const identity={operation_id:'owned-op',port_id:'owned-port'};
      await assert.rejects(joinOwnedPreparationAfterFailure(identity,'/owned/install',{
        read:async()=>row,cancel:async()=>assert.fail('No cancellation after terminal'),
        wait:async probe=>assert.equal(await probe(),true),
        previewQuiescence:async()=>({operation_id:'owned-op',port_id:'owned-port',original_install_path:'/owned/install',...changed}),
      }));
      assert.notEqual(identity.joined,true);
    }
  `,
  );
});

void test("late cancellation conflict preserves natural completion and failed joins retain both errors", () => {
  runDesktopModuleFixture(
    new URL("./desktop-preparation-recovery-test.mts", import.meta.url),
    `
    const {joinOwnedPreparationAfterFailure}=await import(entry);
    const initial={id:'owned-op',operation:'prepare',target_kind:'port',target_id:'owned-port',status:'running',finished_at:null,cancellation:{requested:false,phase:'preparing'}};
    let current=initial,cancels=0;
    const report={operation_id:'owned-op',port_id:'owned-port'};
    const conflict=new Error('Operation completed before cancellation');
    await joinOwnedPreparationAfterFailure(report,'/owned/install',{
      read:async()=>current,cancel:async()=>{cancels++;current={...initial,status:'succeeded',finished_at:1};throw conflict;},
      wait:async probe=>assert.equal(await probe(),true),previewQuiescence:async()=>assert.fail('No retained failed work'),
    });
    assert.equal(cancels,1);assert.equal(report.terminal.status,'succeeded');assert.equal(report.joined,true);
    assert.equal(report.cancellation_error,conflict.message);
    const timeout=new Error('Worker never joined');
    await assert.rejects(joinOwnedPreparationAfterFailure({operation_id:'owned-op',port_id:'owned-port'},'/owned/install',{
      read:async()=>initial,cancel:async()=>{throw conflict;},
      wait:async()=>{throw timeout;},previewQuiescence:async()=>assert.fail('Unjoined worker'),
    }),error=>error instanceof AggregateError&&error.errors[0]===conflict&&error.errors[1]===timeout);
    for(const rejected of [undefined,null,false,0,'']) {
      await assert.rejects(joinOwnedPreparationAfterFailure({operation_id:'owned-op',port_id:'owned-port'},'/owned/install',{
        read:async()=>initial,cancel:async()=>{throw rejected;},
        wait:async()=>{throw timeout;},previewQuiescence:async()=>assert.fail('Unjoined worker'),
      }),error=>error instanceof AggregateError&&Object.is(error.errors[0],rejected)&&error.errors[1]===timeout);
    }
  `,
  );
});

void test("source-intake caller searches its player label before exact port selection", async () => {
  const source = await readFile(
    new URL("./desktop-source-dialog-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    'const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));',
    source.indexOf('await scenario("native-source-intake-and-discovery-dialogs"'),
  );
  const end = source.indexOf("await revealDetailSection", start);
  assert(start >= 0 && end > start);
  const port = {
    id: "opengoal-jak1",
    name: "Owned Jak display name",
    presentation: { source_requirements: [{ label: "Originals" }] },
  };
  let calls = 0;
  const result = runInNewContext(`(async()=>{${source.slice(start, end)}})()`, {
    transportValue: (_contract: string, value: unknown) => value,
    command: () => port,
    required: (value: unknown) => value,
    reviewControls: () => ({}),
    browser: {},
    openCatalogPortAfterRefresh: async (_browser: unknown, actual: unknown, query: unknown) => {
      assert.equal(actual, port);
      assert.equal(query, port.name);
      calls++;
    },
  });
  await result;
  assert.equal(calls, 1);
});

void test("unjoined held preparation exits outside the recorded scenario before later cases", async () => {
  const source = await readFile(new URL("./desktop-preparation-test.mts", import.meta.url), "utf8");
  const start = source.indexOf(
    'await scenario("native-preparation-cancellation", () => livePreparationCancellation());',
  );
  const end = source.indexOf("browser = await interruptedPreparationScenario", start);
  assert(start >= 0 && end > start);
  const primary = new Error("Original card assertion");
  const cleanup = new Error("Worker could not be joined");
  const fatal = new AggregateError([primary, cleanup], "Unsafe owned session", { cause: primary });
  const observed: string[] = [];
  const run = runInNewContext(
    `(async()=>{const preparationSession={};const livePreparationCancellation=async()=>{preparationSession.unjoined={error:fatal};throw primary;};${source.slice(start, end)}})()`,
    {
      primary,
      fatal,
      rethrowFailure: (error: unknown) => {
        throw error;
      },
      scenario: async (name: string, action: () => Promise<void>) => {
        observed.push(name);
        await observeDesktopScenario(action, {
          record: (result) => {
            assert.equal(result.outcome, "failed");
            assert.match(result.message ?? "", /Original card assertion/);
          },
          diagnostics: async () => {},
          screenshot: async () => {},
        });
      },
    },
  );
  await assert.rejects(Promise.resolve(run), (error) => error === fatal);
  assert.deepEqual(observed, ["native-preparation-cancellation"]);
});

void test("unknown owned identity and failed evidence writes preserve the original assertion and abort barrier", async () => {
  const source = await readFile(new URL("./desktop-preparation-test.mts", import.meta.url), "utf8");
  const start = source.indexOf("if (originalFailure !== undefined && startRequested)");
  const end = source.indexOf("\n    }\n    if (evidenceFailure)", start);
  assert(start >= 0 && end > start);
  for (const primary of [
    new Error("Original wait"),
    undefined,
    null,
    false,
    0,
    "original failure",
  ]) {
    for (const writeFails of [false, true]) {
      let nativeCalls = 0,
        writes = 0;
      const disk = new Error("Evidence write failed");
      const result = await runInNewContext(
        `(async()=>{
        const originalFailure={error:primary};const startRequested=true;
        const observations={};const artifacts=[];const activity=undefined;
        let evidenceFailure,caught=false,caughtError;const preparationSession={};
        try{try{throw primary;}finally{${source.slice(start, end)}}}
        catch(error){caught=true;caughtError=error;}
        return {caught,caughtError,unjoinedPreparation:preparationSession.unjoined,observations,evidenceFailure};
      })()`,
        {
          primary,
          assert,
          AggregateError,
          path: { join: () => "/owned/report" },
          output: "/owned",
          errorMessage,
          console: { error: () => {} },
          writeFile: async () => {
            writes++;
            if (writeFails) throw disk;
          },
          read: async () => {
            nativeCalls++;
            assert.fail("Unknown identity must not trigger Core cancellation");
          },
          joinOwnedPreparationAfterFailure: () => assert.fail("No inferred operation owner"),
        },
      );
      assert.ok(isRecord(result));
      assert.equal(result.caught, true);
      assert.equal(result.caughtError, primary);
      assert.ok(isRecord(result.unjoinedPreparation));
      assert.ok(result.unjoinedPreparation.error instanceof AggregateError);
      assert.ok(isRecord(result.observations));
      assert.ok(isRecord(result.observations.failure_cleanup));
      assert.match(
        String(result.observations.failure_cleanup.error),
        /no captured owned operation ID/,
      );
      assert.equal(result.observations.failure_cleanup.owned, undefined);
      assert.equal(nativeCalls, 0);
      assert.equal(writes, 1);
      assert.equal(result.evidenceFailure, undefined);
    }
  }
});

void test("install readback allows independent catalog refresh while retaining exact no-repeat guards", async () => {
  const source = await readFile(new URL("./desktop-install-test.mts", import.meta.url), "utf8");
  const start = source.indexOf("const retryAndBackgroundCommands = new Set(");
  const end = source.indexOf("observations.retry_did_not_repeat_install = true;", start);
  assert(start >= 0 && end > start);
  const block = source.slice(start, end);
  const run = (retry: string[], after: string[], requests: number) =>
    runInNewContext(block, {
      assert,
      observations: { retry_commands: retry, commands_after_retry: after },
      fixture: { requests: Array.from({ length: requests }) },
      requestIndex: 1,
    });
  run(
    ["get_workspace_snapshot", "refresh_official_catalog_automatically", "get_artwork"],
    ["install_port"],
    2,
  );
  assert.throws(() => run(["get_workspace_snapshot", "install_port"], ["install_port"], 2));
  assert.throws(() => run(["get_workspace_snapshot", "remove_port"], ["install_port"], 2));
  assert.throws(() => run(["get_workspace_snapshot"], ["install_port", "install_port"], 2));
  assert.throws(() => run(["get_workspace_snapshot"], ["install_port"], 3));
  assert.throws(() => run(["get_artwork"], ["install_port"], 2));
});

void test("Steam batch distinguishes zero one and two selections before native review", async () => {
  const source = await readFile(new URL("./desktop-steam-entry-test.mts", import.meta.url), "utf8");
  const start = source.indexOf(
    "const boxes = await browser.findElements(",
    source.indexOf('await click(button("Choose games for Steam…"))'),
  );
  const end = source.indexOf(
    "await browser.wait(",
    source.indexOf('await click(button("Review selected shortcuts"));', start),
  );
  assert(start >= 0 && end > start);
  for (const enabledAt of [-1, 0, 1]) {
    let count = 0,
      root = false,
      profile = false,
      reviewed = false;
    const first = { port: { name: "Owned first game" } },
      second = { port: { name: "Owned second game" } };
    const boxes = [0, 1].map((index) => ({
      click: async () => {
        assert.equal(count, index);
        count++;
      },
      getAttribute: async (key: string) => {
        assert.equal(key, "aria-checked");
        return count > index ? "true" : "false";
      },
    }));
    const labels: string[] = [];
    const result = runInNewContext(`(async()=>{${source.slice(start, end)}})()`, {
      assert,
      first,
      second,
      steamRoot: "owned-root",
      steamUserId: "owned-user",
      By: { xpath: (value: string) => value, id: (value: string) => value },
      button: (value: string) => value,
      browser: {
        findElements: async () => boxes,
        findElement: (value: string) => {
          if (value.includes('normalize-space(.)="Owned first game"')) return boxes[0];
          if (value.includes('normalize-space(.)="Owned second game"')) return boxes[1];
          if (value === "steam-batch-installation")
            return {
              sendKeys: async (value: string) => {
                assert.equal(value, "owned-root");
                root = true;
              },
            };
          assert.equal(value, count === 1 ? "Review selected game" : "Review selected shortcuts");
          labels.push(value);
          return { isEnabled: async () => count === enabledAt };
        },
      },
      selectLocalProfile: async () => {
        assert.equal(count, 2);
        assert.equal(root, true);
        profile = true;
      },
      click: async (label: string) => {
        assert.equal(label, "Review selected shortcuts");
        assert.equal(count, 2);
        assert.equal(root, true);
        assert.equal(profile, true);
        reviewed = true;
      },
    });
    if (enabledAt < 0) {
      await result;
      assert.deepEqual(labels, ["Review selected shortcuts", "Review selected game"]);
      assert.equal(reviewed, true);
    } else {
      await assert.rejects(Promise.resolve(result));
      assert.equal(reviewed, false);
    }
  }
});

void test("artwork reload requires exact fixture authority before named virtualized discovery", async () => {
  const source = await readFile(new URL("./desktop-artwork-test.mts", import.meta.url), "utf8");
  const start = source.indexOf("const open = async () => {");
  const end = source.indexOf('await revealDetailSection(browser, "Manage");', start);
  assert(start >= 0 && end > start);
  const port = {
    id: "owned-fixture",
    name: "Owned artwork fixture",
    summary: "Exact owned contract",
  };
  for (const mode of [
    "current",
    "definition-missing",
    "definition-changed",
    "listing-missing",
    "listing-changed",
  ]) {
    const events: string[] = [];
    const selected: string[] = [];
    const workspace = {
      catalog: {
        ports:
          mode === "definition-missing"
            ? []
            : [{ ...port, summary: mode === "definition-changed" ? "Changed" : port.summary }],
      },
      listing_catalog: {
        listings:
          mode === "listing-missing"
            ? []
            : [{ id: port.id, name: mode === "listing-changed" ? "Changed" : port.name }],
      },
    };
    const result = runInNewContext(`(async()=>{${source.slice(start, end)}};await open();})()`, {
      assert,
      port,
      bootstrap: { generation: 7 },
      process: { platform: "win32" },
      required: (value: unknown) => {
        assert(value !== undefined && value !== null);
        return value;
      },
      success: (value: unknown) => value,
      transportValue: (_: string, value: unknown) => value,
      invoke: async (name: string, args: unknown) => {
        assert.equal(name, "get_workspace_snapshot");
        assert.equal(JSON.stringify(args), JSON.stringify({ generation: 7 }));
        events.push("workspace");
        return workspace;
      },
      observations: {
        capture: async () => {
          events.push("capture");
        },
        begin: async () => {
          events.push("begin");
        },
      },
      browser: {
        navigate: () => ({
          refresh: async () => {
            events.push("reload");
          },
        }),
        wait: async (value: unknown) =>
          value === "port-search"
            ? {
                sendKeys: async (...values: unknown[]) => {
                  assert.equal(values.at(-1), port.name);
                  events.push("search");
                },
              }
            : value,
        findElement: () => assert.fail("The real located search is required"),
      },
      By: {
        css: (value: string) => value,
        xpath: (value: string) => value,
        id: (value: string) => value,
      },
      until: { elementLocated: (value: unknown) => value },
      Key: {
        CONTROL: "Control",
        COMMAND: "Command",
        BACK_SPACE: "Backspace",
        chord: (...values: unknown[]) => values.join("+"),
      },
      click: async () => {
        events.push("discover");
      },
      clearCatalogFilters: async () => {
        events.push("filters");
      },
      selectCatalogPort: async (_: unknown, id: string) => {
        selected.push(id);
        events.push("exact-id");
      },
    });
    if (mode === "current") {
      await result;
      assert.deepEqual(events, [
        "capture",
        "reload",
        "begin",
        "workspace",
        "discover",
        "search",
        "filters",
        "exact-id",
      ]);
      assert.deepEqual(selected, [port.id]);
    } else {
      await assert.rejects(Promise.resolve(result));
      assert.deepEqual(events, ["capture", "reload", "begin", "workspace"]);
      assert.deepEqual(selected, []);
    }
  }
});

void test("remaining Discover reopen callers search by display name before exact ID selection", async () => {
  for (const [file, call] of [
    [
      "desktop-source-intake-boundaries-test.mts",
      "await openCatalogPortAfterRefresh(browser, fixture.port",
    ],
    ["desktop-cli-handoff-test.mts", "await openCatalogPortAfterRefresh(browser, port"],
  ] as const) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    const start = source.indexOf(call),
      end = source.indexOf(";", start) + 1;
    assert(start >= 0 && end > start);
    const port = { id: "owned-stable-id", name: "Owned visible name" };
    let calls = 0;
    await runInNewContext(`(async()=>{${source.slice(start, end)}})()`, {
      browser: {},
      port,
      fixture: { port },
      openCatalogPortAfterRefresh: async (_: unknown, actual: unknown, query: unknown) => {
        assert.equal(actual, port);
        assert.equal(query, port.name);
        calls++;
      },
    });
    assert.equal(calls, 1);
  }
});

void test("preliminary setup asserts the live count and exact selected checkbox without a catalog denominator", async () => {
  const source = await readFile(
    new URL("./desktop-source-dialog-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "await clickVisible(browser, checkbox);",
    source.indexOf("async function preliminarySelectedSetupScenario("),
  );
  const end = source.indexOf('await screenshot("preliminary-selected-queue");', start);
  assert(start >= 0 && end > start);
  for (const [count, checked, mutated] of [
    ["1 selected", "true", false],
    ["0 selected", "true", false],
    ["1 selected", "false", false],
    ["1 selected", "true", true],
  ] as const) {
    const checkbox = {},
      checkboxLocator = { ownedId: "exact-owned-port" },
      statuses = [{ port_id: "owned", active: null }];
    let clicked = false;
    const result = runInNewContext(`(async()=>{${source.slice(start, end)}})()`, {
      assert,
      browser: {},
      checkbox,
      checkboxLocator,
      statuses,
      By: { css: (value: string) => value },
      queue: {
        findElement: (selector: unknown) => {
          if (selector === '[role="status"]') return { getText: async () => count };
          assert.equal(selector, checkboxLocator);
          return {
            getAttribute: async (key: string) => {
              assert.equal(key, "aria-checked");
              return checked;
            },
          };
        },
      },
      clickVisible: async (_: unknown, actual: unknown) => {
        assert.equal(actual, checkbox);
        clicked = true;
      },
      read: async (name: string) => {
        assert.equal(name, "get_statuses");
        return mutated ? [] : statuses;
      },
    });
    if (count === "1 selected" && checked === "true" && !mutated) await result;
    else await assert.rejects(Promise.resolve(result));
    assert.equal(clicked, true);
  }
});

void test("game-first owner registers its exact scenario without native, source or installation effects", () => {
  const entry = new URL("./desktop-game-first-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const {gameFirstScenarios}=await import(entry);
      const attempts=[];
      await gameFirstScenarios({scenario:async(id,action)=>{
        assert.equal(typeof action,'function');attempts.push(id);
      }});
      assert.deepEqual(attempts,['native-game-first-choice-and-restart']);
    `,
        variant === "original" ? undefined : { exportName: "gameFirstScenarios", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

void test("game-first serialized capture retains optional alerts while requiring fonts and actual interface size", () => {
  const entry = new URL("./desktop-game-first-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const {runInNewContext}=await import('node:vm');
      const {observeGameFirstCaptureReadiness:observe}=await import(entry);
      let comparisonPending=false;
      const document={fonts:{status:'loaded'},body:{textContent:'Interface size 200%.'},
        documentElement:{scrollWidth:480,clientWidth:480},
        querySelectorAll:selector=>{
          if(selector==='.comparison-context-heading button:disabled')return comparisonPending?[{}]:[];
          assert.equal(selector,'[role="alert"]');
          return [{textContent:' Optional comparison evidence unavailable '}];
        }};
      const read=()=>JSON.parse(JSON.stringify(runInNewContext('('+String(observe)+')(200)',{
        document,innerWidth:480,innerHeight:320,devicePixelRatio:2
      })));
      const settled=read();
      assert.equal(settled.ready,true);
      assert.deepEqual(settled.alerts,['Optional comparison evidence unavailable']);
      assert.deepEqual(settled.viewport,{width:480,height:320,dpr:2});
      comparisonPending=true;assert.equal(read().ready,false);
      comparisonPending=false;assert.equal(read().ready,true);
      document.fonts.status='loading';assert.equal(read().ready,false);
      document.fonts.status='loaded';document.body.textContent='Applying interface size 200%.';
      assert.equal(read().ready,false);
      document.body.textContent='Interface size 100%.';assert.equal(read().ready,false);
    `,
        variant === "original"
          ? undefined
          : { exportName: "observeGameFirstCaptureReadiness", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

// Exercise the actual serialized probe with a deterministic frame consumer. The
// consumer models layout receivers, not production controller functionality.
async function controllerObservation(probeSource: string) {
  const document = {
    activeElement: undefined as HTMLElement | undefined,
    documentElement: { dataset: { inputMode: "keyboard" } as Record<string, string> },
    body: {
      append: (element: HTMLElement) => {
        dialog = element;
      },
    },
    createElement: () => new HTMLElement(),
    hasFocus: () => true,
  };
  class HTMLElement {
    children: HTMLElement[] = [];
    style = { cssText: "" };
    textContent = "";
    isConnected = true;
    onclick?: () => void;
    setAttribute() {}
    append(element: HTMLElement) {
      this.children.push(element);
    }
    get firstElementChild() {
      return this.children[0];
    }
    getClientRects() {
      return [{}];
    }
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    focus() {
      document.activeElement = this;
      document.documentElement.dataset.inputMode = "controller";
    }
    remove() {
      this.isConnected = false;
    }
  }
  let dialog: HTMLElement | undefined;
  const previousFocus = new HTMLElement();
  document.activeElement = previousFocus;
  const originalPads = () => [] as { buttons: { pressed: boolean }[] }[];
  const navigator = { getGamepads: originalPads };
  const originalRect = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  const originalClients = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getClientRects");
  let wasActive = false;
  const outside = new HTMLElement();
  let ticks = 0;
  const probe = callable(
    runInNewContext(`(${probeSource})`, {
      HTMLElement,
      document,
      navigator,
      performance: { now: () => ++ticks },
      queueMicrotask,
      requestAnimationFrame: (callback: (tick: number) => void) =>
        queueMicrotask(() => {
          const [pad] = navigator.getGamepads();
          assert.ok(pad && dialog);
          const active = pad.buttons[0]?.pressed;
          if (active && !wasActive) {
            dialog.getClientRects();
            dialog.children[0]?.getClientRects();
            dialog.children[0]?.onclick?.();
          }
          wasActive = Boolean(active);
          if (pad.buttons[13]?.pressed) {
            dialog.getClientRects();
            for (const control of dialog.children) {
              control.getClientRects();
              control.getBoundingClientRect();
            }
            // The focus reveal's sub-pixel containment measures the revealed control
            // and its scroller (focus.ts containWithinScroller): one extra read each.
            dialog.children[0]?.getBoundingClientRect();
            dialog.getBoundingClientRect();
            // Shell focus/reflow work remains in the global profile and gets its
            // own attribution; it must not turn 1000 controls into 1003 controls.
            for (let index = 0; index < 3; index++) outside.getBoundingClientRect();
          }
          callback(++ticks);
        }),
    }),
  );
  let calls = 0;
  let report: unknown;
  await probe((value: unknown) => {
    calls++;
    report = value;
  });
  assert.equal(calls, 1);
  assert.ok(isRecord(report));
  assert.equal(report.error, undefined);
  assert.equal(report.control_count, 1000);
  assert.equal(navigator.getGamepads, originalPads);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect"),
    originalRect,
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getClientRects"),
    originalClients,
  );
  assert.equal(document.activeElement, previousFocus);
  assert.equal(document.documentElement.dataset.inputMode, "keyboard");
  assert.equal(dialog?.isConnected, false);
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

function actualControllerObservation() {
  const output = runDesktopModuleFixture(
    new URL("./desktop-controller-test.mts", import.meta.url),
    `
      import {runInNewContext} from 'node:vm';
      import {isRecord} from ${JSON.stringify(new URL("../../../scripts/runtime-values.mts", import.meta.url).href)};
      const {observeInjectedController}=await import(entry);
      const callable=${callable.toString()};
      console.log(JSON.stringify(await (${controllerObservation.toString()})(observeInjectedController.toString())));
    `,
  );
  const report: unknown = JSON.parse(output);
  assert.ok(isRecord(report));
  return report;
}

void test("native remainder controller attributes unrelated layout reads and restores injected methods", async () => {
  const report = actualControllerObservation();
  assert.ok(Array.isArray(report.samples));
  const direction: unknown = report.samples[3];
  assert.ok(isRecord(direction));
  assert.equal(direction.getBoundingClientRect, 1005);
  assert.deepEqual(direction.fixture_controls, {
    getClientRects: 1000,
    getBoundingClientRect: 1001,
  });
  assert.deepEqual(direction.fixture_container, { getClientRects: 1, getBoundingClientRect: 1 });
  assert.deepEqual(direction.outside_fixture, { getClientRects: 0, getBoundingClientRect: 3 });
});

void test("native remainder controller retains exact control count and rejects unattributed reads", async () => {
  const original = actualControllerObservation();
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("./desktop-controller-test.mts", import.meta.url),
        `
      import path from 'node:path';
      const {WebDriver}=await import('selenium-webdriver');
      const navigation=[],reports=[];
      const fileSystem=await import('node:fs/promises');
      mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(fileSystem).filter(([name])=>name!=='default')),writeFile:async(file,bytes,options)=>{
        assert.ok(['controller-capability.json','controller-layout-profile.json'].includes(path.basename(file)));
        assert.equal(path.dirname(file),'owned-output');
        assert.deepEqual(options,{flag:'wx'});reports.push({file,value:JSON.parse(bytes)});
      }}});
      mock.module(new URL('./desktop-review-controls.mts',entry).href,{namedExports:{
        selectPrimaryNavigation:async(browser,label)=>{
          assert.ok(browser instanceof WebDriver);assert.equal(label,'Library');navigation.push(browser);
        },
      }});
      const {controllerScenario}=await import(entry);
      let profile=${JSON.stringify(original)};
      const original=profile;
      class ControlledBrowser extends WebDriver{
        executeScript(){return {outcome:'api-present-no-controller'};}
        executeAsyncScript(){
          assert.equal(navigation.at(-1),this,'Navigate before injecting the controller probe');return profile;
        }
      }
      const context={browser:new ControlledBrowser(),output:'owned-output',artifacts:[],
        scenario:async(name,work)=>{if(name==='native-controller-large-list')await work();}};
      await controllerScenario(context);
      assert.deepEqual(navigation,[context.browser]);
      const damaged=structuredClone(original),direction=damaged.samples[3];
      direction.fixture_controls.getBoundingClientRect=1003;
      direction.getBoundingClientRect=1007;profile=damaged;
      await assert.rejects(()=>controllerScenario(context),/1003 !== 1001/);
      direction.fixture_controls.getBoundingClientRect=1001;
      await assert.rejects(()=>controllerScenario(context),/Every layout read must retain its receiver attribution/);
      assert.deepEqual(navigation,[context.browser,context.browser,context.browser]);
      assert.deepEqual(context.artifacts,Array.from({length:3},()=>[
        path.join('owned-output','controller-capability.json'),
        path.join('owned-output','controller-layout-profile.json')]).flat());
      assert.equal(reports.length,6);
      `,
        variant === "original" ? undefined : { exportName: "controllerScenario", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

async function paletteBehavior(
  run: (context: unknown) => Promise<unknown>,
  prepare: (events: string[]) => void,
) {
  for (const escapeFails of [false, true]) {
    const events: string[] = [];
    const ids = [
      "command-catalog",
      "command-search-library",
      "command-search",
      "command-updates",
      "command-game-updates",
      "command-adopt",
    ];
    let index = -1;
    let open = false;
    const original = {
      fontSize: "110%",
      fontPriority: "important",
      inputMode: "keyboard",
      nativeKeyboardInputMode: "prior",
    };
    const style = {
      fontSize: original.fontSize,
      getPropertyValue: () => original.fontSize,
      getPropertyPriority: () => original.fontPriority,
      setProperty: (...args: unknown[]) => {
        events.push(`style:${JSON.stringify(args)}`);
      },
      removeProperty: () => {
        throw new Error("Original font size must be preserved");
      },
    };
    const root = {
      style,
      dataset: {
        inputMode: original.inputMode,
        nativeKeyboardInputMode: original.nativeKeyboardInputMode,
      },
    };
    const search = {
      getAttribute: (name: string) => (name === "value" ? "" : ids[index]),
      sendKeys: async () => {
        index++;
        root.dataset.nativeKeyboardInputMode = "keyboard";
      },
    };
    const document = {
      documentElement: root,
      activeElement: search as unknown,
      querySelector: () => ({ closest: () => null }),
      querySelectorAll: (selector: string) =>
        selector.includes("controller-hint")
          ? (root.dataset.inputMode === "controller"
              ? ["D-pad or stick: Move", "Confirm button: Select", "Back button: Back"]
              : ["Arrow keys: Move", "Enter: Select", "Esc: Back"]
            ).map((textContent) => ({ textContent, getClientRects: () => [{}] }))
          : [],
    };
    class HTMLElement {
      focus() {
        document.activeElement = this;
      }
    }
    const trigger = new HTMLElement();
    const browser = {
      manage: () => ({
        window: () => ({
          getRect: async () => ({ width: 900, height: 700 }),
          setRect: async () => {
            events.push("window");
          },
        }),
      }),
      executeScript: (script: (...args: unknown[]) => unknown, ...args: unknown[]) => {
        const result = runInNewContext(`(${script.toString()})(...args)`, {
          args,
          document,
          HTMLElement,
          window: { addEventListener() {} },
          queueMicrotask,
        });
        // Selenium returns JSON observations in the caller's realm.
        const observation: unknown =
          typeof result === "object" && result !== null
            ? JSON.parse(JSON.stringify(result))
            : result;
        return observation;
      },
      findElement: async (selector: string) =>
        selector.includes("command-trigger")
          ? trigger
          : selector === ".palette-footer .controller-hint"
            ? {
                getAttribute: () => null,
                findElement: () => ({
                  click: async () => {
                    events.push("help-open");
                  },
                }),
              }
            : selector === "#command-check"
              ? { getAttribute: () => "", getText: () => "Install a port before checking" }
              : search,
      findElements: async () => (open ? [{}] : []),
      actions() {
        let escape = false;
        const actions = {
          keyDown: () => actions,
          keyUp: () => actions,
          sendKeys: (key: string) => {
            escape = key === "Escape";
            return actions;
          },
          perform: async () => {
            if (!escape) {
              open = true;
              document.activeElement = search;
            } else {
              events.push("escape");
              if (escapeFails) throw new Error("retained Escape transport failure");
              open = false;
            }
          },
        };
        return actions;
      },
      wait: async (condition: unknown) => {
        if (typeof condition === "function") assert.ok(await callable(condition)());
      },
      takeScreenshot: async () => {
        events.push("capture");
        return "owned-failure-image";
      },
      navigate: () => ({
        refresh: async () => {
          events.push("refresh");
          open = false;
        },
      }),
    };
    prepare(events);
    let failure: unknown;
    try {
      await run({
        browser,
        output: "owned-output",
        artifacts: [],
        scenario: async (_name: string, work: () => Promise<void>) => work(),
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(errorMessage(failure), /retained expanded-layout assertion/);
    assert.equal(
      index,
      5,
      "The unavailable check must be skipped after every explicitly named preceding command",
    );
    assert.ok(events.indexOf("expanded") < events.indexOf("capture"));
    assert.ok(events.indexOf("help-open") < events.indexOf("expanded"));
    assert.ok(events.indexOf("capture") < events.indexOf("escape"));
    assert.ok(events.includes(`style:${JSON.stringify(["font-size", "110%", "important"])}`));
    assert.ok(events.includes("window"));
    assert.equal(events.at(-1), "refresh");
    assert.equal(open, false);
    assert.deepEqual(root.dataset, { inputMode: "keyboard", nativeKeyboardInputMode: "prior" });
    if (escapeFails) {
      assert.ok(isRecord(failure) && Array.isArray(failure.errors));
      assert.equal(failure.errors.length, 2);
      assert.match(errorMessage(failure.errors[1]), /retained Escape transport failure/);
    }
  }
}

void test("native remainder palette walks explicit commands and restores renderer after a failed assertion", () => {
  const entry = new URL("./desktop-accessibility-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      import path from 'node:path';import {runInNewContext} from 'node:vm';
      const {isRecord,errorMessage}=await import(new URL('../../../scripts/runtime-values.mts',entry));
      const callable=${String(callable)};
      let events=[];
      const files=await import('node:fs/promises');
      mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(files).filter(([name])=>name!=='default')),writeFile:async(file,bytes,options)=>{
        assert.equal(path.dirname(file),'owned-output');assert.ok(path.basename(file).includes('expanded-navigation'));events.push('write');
      }}});
      mock.module('selenium-webdriver',{namedExports:{
        By:{css:value=>value},Key:{CONTROL:'Control',COMMAND:'Command',ARROW_DOWN:'ArrowDown',ESCAPE:'Escape'},until:{elementLocated:value=>value},
      }});
      mock.module(new URL('./desktop-review-controls.mts',entry).href,{namedExports:{
        assertCompactReview:async()=>{events.push('expanded');throw Error('retained expanded-layout assertion');},
        captureAccessibilityReport:()=>assert.fail('The failed layout must precede accessibility capture'),
        observeAccessibility:()=>assert.fail('The failed layout must precede accessibility observation'),
        assertNoAccessibilityViolations:()=>assert.fail('The failed layout must precede accessibility checks'),
      }});
      const {accessibleNavigationScenario}=await import(entry);
      await (${String(paletteBehavior)})(accessibleNavigationScenario,value=>events=value);
    `,
        variant === "original"
          ? undefined
          : { exportName: "accessibleNavigationScenario", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

async function settledRecoveryBehavior(subject: (browser: unknown) => Promise<unknown>) {
  const events: string[] = [];
  let overlayPresent = true;
  let activityClicks = 0;
  let observeOverlay!: () => void;
  const overlayObserved = new Promise<void>((resolve) => {
    observeOverlay = resolve;
  });
  let releaseOverlay!: () => void;
  const maySettle = new Promise<void>((resolve) => {
    releaseOverlay = resolve;
  });
  const run = () =>
    subject({
      findElements: async (selector: string) => {
        if (selector === '[data-slot="dialog-overlay"]') {
          events.push(overlayPresent ? "overlay present" : "overlay absent");
          return overlayPresent ? [{}] : [];
        }
        assert.equal(selector, "section[data-detail-workspace]");
        assert.equal(activityClicks, 1);
        events.push("detail absent");
        return [];
      },
      findElement: (selector: string) => {
        assert.equal(selector, '//nav//button[./span[normalize-space(.)="Activity"]]');
        return {
          click: async () => {
            activityClicks += 1;
            assert.equal(overlayPresent, false, "ordinary navigation remains blocked by the modal");
            events.push("Activity click");
          },
        };
      },
      wait: async (condition: unknown, timeout: number, message?: string) => {
        assert.equal(timeout, 15_000);
        if (typeof condition !== "function") {
          assert.equal(condition, '[data-detail-origin="error:preparation-review"]');
          events.push("recovery action located");
          return;
        }
        if (message !== undefined) {
          assert.equal(
            message,
            "The settled preparation review must release its modal overlay before navigation",
          );
          assert.equal(await callable(condition)(), false);
          observeOverlay();
          await maySettle;
          assert.equal(await callable(condition)(), true);
          return;
        }
        assert.equal(await callable(condition)(), true);
      },
    });
  const completion = Promise.resolve(run());
  try {
    await Promise.race([
      overlayObserved,
      completion.then(() => assert.fail("Activity navigation finished before overlay observation")),
    ]);
    assert.equal(activityClicks, 0);
    assert.deepEqual(events, ["recovery action located", "overlay present"]);
  } finally {
    overlayPresent = false;
    releaseOverlay();
  }
  assert.equal(await completion, '[data-detail-origin="error:preparation-review"]');
  assert.equal(activityClicks, 1);
  assert.deepEqual(events, [
    "recovery action located",
    "overlay present",
    "overlay absent",
    "Activity click",
    "detail absent",
  ]);
}

void test("direct preparation recovery waits for modal settlement before its ordinary Activity click", () => {
  const entry = new URL("./desktop-preparation-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const callable=${String(callable)};
      const forbiddenConstructor=class{constructor(){throw Error('Unexpected native driver construction');}};
      mock.module('selenium-webdriver',{namedExports:{By:{css:value=>value,xpath:value=>value},Key:{},until:{elementLocated:value=>value},WebDriver:forbiddenConstructor,Session:forbiddenConstructor,Capabilities:forbiddenConstructor}});
      const {settleDirectPreparationRecovery}=await import(entry);
      await (${String(settledRecoveryBehavior)})(settleDirectPreparationRecovery);
    `,
        variant === "original"
          ? undefined
          : { exportName: "settleDirectPreparationRecovery", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

async function stuckRecoveryBehavior(subject: (browser: unknown) => Promise<unknown>) {
  const timeoutFailure = new Error("retained modal-settlement timeout");
  let recoveryLocated = false;
  let overlayReads = 0;
  let activityClicks = 0;
  const run = () =>
    subject({
      findElements: async (selector: string) => {
        assert.equal(selector, '[data-slot="dialog-overlay"]');
        overlayReads += 1;
        return [{}];
      },
      findElement: (selector: string) => {
        assert.equal(selector, '//nav//button[./span[normalize-space(.)="Activity"]]');
        return {
          click: async () => {
            activityClicks += 1;
          },
        };
      },
      wait: async (condition: unknown, timeout: number, message?: string) => {
        assert.equal(timeout, 15_000);
        if (typeof condition !== "function") {
          assert.equal(condition, '[data-detail-origin="error:preparation-review"]');
          recoveryLocated = true;
          return;
        }
        assert.equal(recoveryLocated, true);
        assert.equal(
          message,
          "The settled preparation review must release its modal overlay before navigation",
        );
        // Model finite WebDriver deadline exhaustion after two unsuccessful polls;
        // no wall-clock wait, retrying click or test-owned dialog dismissal occurs.
        assert.equal(await callable(condition)(), false);
        assert.equal(await callable(condition)(), false);
        throw timeoutFailure;
      },
    });
  await assert.rejects(Promise.resolve(run()), (error: unknown) => error === timeoutFailure);
  assert.equal(recoveryLocated, true);
  assert.equal(overlayReads, 2);
  assert.equal(activityClicks, 0);
}

void test("direct preparation recovery propagates a stuck modal timeout without clicking Activity", () => {
  const entry = new URL("./desktop-preparation-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const callable=${String(callable)};
      const forbiddenConstructor=class{constructor(){throw Error('Unexpected native driver construction');}};
      mock.module('selenium-webdriver',{namedExports:{By:{css:value=>value,xpath:value=>value},Key:{},until:{elementLocated:value=>value},WebDriver:forbiddenConstructor,Session:forbiddenConstructor,Capabilities:forbiddenConstructor}});
      const {settleDirectPreparationRecovery}=await import(entry);
      await (${String(stuckRecoveryBehavior)})(settleDirectPreparationRecovery);
    `,
        variant === "original"
          ? undefined
          : { exportName: "settleDirectPreparationRecovery", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});
