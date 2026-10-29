import { errorCode, errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
// One normal-app read-response fixture. No game launch, source registration or consent mutation.
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import type { WebDriver, WebElement, Locator } from "selenium-webdriver";
import type {
  PortDefinition,
  PortSourceContract,
  SourceIdentityProfile,
} from "../src/transport-types.generated.d.ts";
interface HistoryContext {
  browser: WebDriver;
  invoke: (command: string) => Promise<unknown>;
  scenario: (name: string, action: () => Promise<void>) => Promise<unknown>;
  output: string;
  artifacts: string[];
  captureScreenshot: (name: string, required?: boolean) => Promise<void>;
}
interface HistoryProbe {
  original: typeof fetch;
  data: HistoryFixture;
  mode: string;
  snapshots: number;
  reports: number;
  modeSnapshots: Record<string, number>;
}
type HistoryWindow = Window & {
  __portcoveHistoryProbe?: HistoryProbe;
  __TAURI_INTERNALS__?: {
    convertFileSrc(command: string, protocol: string): string;
    invoke(command: string, args: object): Promise<unknown>;
  };
};
type HistoryFixture = ReturnType<typeof qualificationHistoryFixture>;
interface HistoryView {
  theme: string;
  width: number;
  height: number;
  font: string;
}
interface HistoryLayout {
  viewport: { width: number; height: number };
  font_size: string;
  bounds: { left: number; right: number; top: number; bottom: number };
  horizontal_overflow: boolean;
  theme: string | undefined;
}
interface HistoryRestoration {
  restored: boolean;
  installed?: boolean;
  snapshots?: number;
  reports?: number;
  error?: unknown;
  window_error?: string;
}
interface HistoryObservation {
  limitation: string;
  source_response: HistoryFixture;
  views: (HistoryLayout & {
    name: string;
    rendered_branch: string;
    expected_view: HistoryView;
    tab_steps: number | null;
    window: { width: number; height: number; x: number; y: number };
  })[];
  failure?: { message: string };
  restoration?: unknown;
  native_source_restoration?: unknown;
  window_restoration_error?: string;
  restoration_validation_failure?: { message: string };
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Historical fixture observation must be an object");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string", "Historical fixture text field required");
  return value;
}
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function entries(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  const rows: unknown[] = value;
  return rows.map(object);
}

// Linux history uses the harness's existing detached driver group and SIGTERM.
// These observations add ownership/exit proof; they never signal a process.
interface HistoryProcess {
  state: string;
  pid: number;
  parent: number;
  group: number;
  start_ticks: string;
  executable: string | null;
}
interface HistoryInventory {
  owner: HistoryProcess;
  driver: HistoryProcess;
  processes: HistoryProcess[];
}
export function assertHistoryRestoration(
  restored: unknown,
  nativeRaw: unknown,
  { scenarioFailed, windowError }: { scenarioFailed: boolean; windowError?: unknown },
) {
  const rawRestoration = object(restored);
  assert.ok(typeof rawRestoration.restored === "boolean");
  const restoration: HistoryRestoration = {
    ...rawRestoration,
    restored: rawRestoration.restored,
  };
  if (rawRestoration.installed !== undefined) {
    assert.ok(typeof rawRestoration.installed === "boolean");
    restoration.installed = rawRestoration.installed;
  }
  for (const key of ["snapshots", "reports"] as const) {
    const count = rawRestoration[key];
    if (count !== undefined) {
      assert.ok(typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
      restoration[key] = count;
    }
  }
  assert.equal(restoration.restored, true);
  if (!scenarioFailed && restoration.installed !== false)
    assert.ok(required(restoration.snapshots) > 0 && required(restoration.reports) > 0);
  assert.equal(restoration.error, undefined);
  assert.equal(windowError, undefined);
  const nativeReply = object(nativeRaw);
  assert.equal(nativeReply.ok, true);
  assert.ok(Array.isArray(nativeReply.value));
  assert.equal(nativeReply.value.length, 0, "Synthetic responses must not register source data");
}

export async function readHistoryProcess(
  pid: string | number,
  {
    read = readFile,
    link = readlink,
  }: {
    read?: (file: string, encoding: "utf8") => Promise<string>;
    link?: (file: string) => Promise<string>;
  } = {},
): Promise<HistoryProcess | null> {
  const raw = await read(`/proc/${pid}/stat`, "utf8").catch((error) => {
    // A process can exit after procfs opens stat but before its contents are read.
    if (["ENOENT", "ESRCH"].includes(errorCode(error) ?? "")) return null;
    throw error;
  });
  if (!raw) return null;
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const startTicks = fields[19];
  assert.ok(typeof state === "string" && typeof startTicks === "string");
  assert.match(startTicks, /^\d+$/u);
  const executable = await link(`/proc/${pid}/exe`).catch((error) => {
    if (["ENOENT", "EACCES", "EPERM"].includes(errorCode(error) ?? "")) return null;
    throw error;
  });
  return {
    state,
    pid: Number(pid),
    parent: Number(fields[1]),
    group: Number(fields[2]),
    start_ticks: startTicks,
    executable,
  };
}

function sameHistoryIdentity(expected: HistoryProcess, actual: HistoryProcess | null) {
  assert.ok(actual, `Captured native PID ${expected.pid} exited before identity validation`);
  for (const key of ["pid", "parent", "group", "start_ticks", "executable"] as const)
    assert.equal(actual[key], expected[key], `Captured native ${key} changed`);
}

export async function captureHistoryDriver(driverPid: number, driverPath: string) {
  assert.equal(process.platform, "linux");
  const owner = await readHistoryProcess(process.pid);
  const driver = await readHistoryProcess(driverPid);
  assert.ok(driver && owner, "Owned history driver is not running");
  assert.equal(driver.parent, owner.pid);
  assert.equal(driver.group, driver.pid, "History driver must retain its owned detached group");
  assert.equal(driver.executable, await realpath(driverPath));
  assert.ok(BigInt(driver.start_ticks) >= BigInt(owner.start_ticks));
  return { owner, driver, processes: [driver] };
}

export async function captureHistorySession(
  driverPid: number,
  driverPath: string,
  applicationPath: string,
  phase = "interaction",
) {
  assert.ok(["interaction", "cleanup"].includes(phase));
  const { owner, driver } = await captureHistoryDriver(driverPid, driverPath);
  const all = (
    await Promise.all(
      (await readdir("/proc"))
        .filter((name) => /^\d+$/.test(name))
        .map((pid) => readHistoryProcess(pid)),
    )
  ).filter((entry) => entry !== null);
  const processes = [driver];
  for (let index = 0; index < processes.length; index++) {
    const parent = processes[index];
    assert.ok(parent);
    for (const child of all.filter((entry) => entry.parent === parent.pid)) {
      assert.ok(child.executable, "Owned descendant executable identity is unavailable");
      assert.ok(
        BigInt(child.start_ticks) >= BigInt(parent.start_ticks),
        "Native ancestry creation order is invalid",
      );
      assert.ok(!processes.some((entry) => entry.pid === child.pid), "Native ancestry cycle");
      processes.push(child);
    }
  }
  const appExecutable = await realpath(applicationPath);
  const application = processes.find((entry) => entry.executable === appExecutable);
  const webviews = processes.filter(
    (entry) => entry.executable !== null && path.basename(entry.executable) === "WebKitWebProcess",
  );
  if (phase === "interaction") {
    assert.ok(application, "Exact history application is not an observed driver descendant");
    assert.ok(webviews.length, "Actual WebKit WebProcess identity is required before interaction");
  }
  for (const entry of processes) sameHistoryIdentity(entry, await readHistoryProcess(entry.pid));
  return { owner, driver, application, webviews, processes, captured_at: new Date().toISOString() };
}

export async function historyDriverStillOwned(inventory: Pick<HistoryInventory, "driver">) {
  const current = await readHistoryProcess(inventory.driver.pid);
  if (!current || current.state === "Z") return false;
  sameHistoryIdentity(inventory.driver, current);
  return true;
}

export async function waitHistorySessionExit(inventory: Pick<HistoryInventory, "processes">) {
  const deadline = Date.now() + 5_000;
  let remaining: number[];
  do {
    remaining = [];
    const unreaped_terminal: { captured: HistoryProcess; observed: HistoryProcess }[] = [];
    for (const entry of inventory.processes) {
      const current = await readHistoryProcess(entry.pid);
      if (current?.start_ticks !== entry.start_ticks) continue;
      assert.equal(current.pid, entry.pid);
      // A matching-birth zombie has positively exited execution, but its parent
      // has not reaped it. Preserve that distinction instead of claiming absence.
      if (current.state === "Z") unreaped_terminal.push({ captured: entry, observed: current });
      else remaining.push(entry.pid);
    }
    if (!remaining.length)
      return {
        all_exited: true,
        all_reaped: unreaped_terminal.length === 0,
        unreaped_terminal,
        observed_at: new Date().toISOString(),
        captured: inventory,
      };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    `Captured history processes did not exit within 5 seconds: ${remaining.join(", ")}`,
  );
}

// The repository-level scripts/desktop-scenarios.test.mts consumes this export.
// Its test root is outside the frontend Fallow graph.
export function qualificationHistoryFixture(catalog: unknown) {
  const raw = object(catalog);
  const portRecord = required(entries(raw.ports).find((entry) => entry.id === "snap64-recomp"));
  const port: Pick<PortDefinition, "id" | "name" | "source_profile"> = {
    ...portRecord,
    id: text(portRecord.id),
    name: text(portRecord.name),
    source_profile: text(portRecord.source_profile),
  };
  const source = object(raw.source_catalog);
  const contractRecord = required(
    entries(source.contracts).find((entry) => entry.port_id === port.id && entry.role === "game"),
  );
  const contract: Pick<PortSourceContract, "port_id" | "profile_id" | "role"> = {
    ...contractRecord,
    port_id: text(contractRecord.port_id),
    profile_id: text(contractRecord.profile_id),
    role: "game",
  };
  const records = entries(source.qualification).filter(
    (entry) => object(entry.scope).port_id === port.id,
  );
  assert.ok(records.length, "Maintained Snap64 history is required");
  const identityRecord = required(
    entries(source.identities).find((entry) => entry.id === port.source_profile),
  );
  const identity: Pick<SourceIdentityProfile, "id"> = {
    ...identityRecord,
    id: text(identityRecord.id),
  };
  return {
    port_id: port.id,
    profile_id: port.source_profile,
    report: {
      schema_version: 1,
      profile_id: port.source_profile,
      health: "missing",
      state_code: "not_inspected",
      summary: "Synthetic historical read; current files not inspected",
      next_action: "Select files",
      expected_identity: identity,
      applications: [
        {
          port_id: port.id,
          port_name: port.name,
          role: "game",
          contract,
          contract_result: { state: "not_evaluated" },
          release_applicability: { state_code: "not_rebound", reviewed_bindings: [] },
          qualification: {
            legacy_automated_platforms: [],
            legacy_hands_on_platforms: [],
            exact_records: records,
          },
        },
      ] as const,
      evidence: [],
      legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
    },
  };
}

export async function installHistoryFixture(browser: WebDriver, fixture: HistoryFixture) {
  const installed = await browser.executeAsyncScript<unknown>(
    (data: HistoryFixture, done: (result: unknown) => void) => {
      const host = window as HistoryWindow;
      const native = host.__TAURI_INTERNALS__;
      if (!native) throw new Error("Native history bridge missing");
      const original = window.fetch;
      const snapshotUrl = native.convertFileSrc("get_workspace_snapshot", "ipc");
      const inspectionUrl = native.convertFileSrc("inspect_source", "ipc");
      const probe: HistoryProbe = {
        original,
        data,
        mode: "managed",
        snapshots: 0,
        reports: 0,
        modeSnapshots: {},
      };
      host.__portcoveHistoryProbe = probe;
      function record(value: unknown): Record<string, unknown> {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Malformed history response object");
        return value as Record<string, unknown>;
      }
      function records(value: unknown): Record<string, unknown>[] {
        if (!Array.isArray(value)) throw new Error("Malformed history response array");
        return value.map((item: unknown) => record(item));
      }
      function suppliedSnapshot(value: unknown) {
        const snapshot = record(value);
        probe.snapshots++;
        probe.modeSnapshots[probe.mode] = (probe.modeSnapshots[probe.mode] ?? 0) + 1;
        snapshot.sources = [
          {
            profile_id: data.profile_id,
            path: "owned-synthetic-history.rom",
            sha256: "0".repeat(64),
            size: 0,
            storage_sha256: "0".repeat(64),
            storage_size: 0,
            updated_at: 1,
          },
        ];
        const port = records(record(snapshot.catalog).ports).find(
          (entry) => entry.id === data.port_id,
        );
        if (!port) throw new Error("History fixture port missing from workspace");
        const release = record(port.release);
        if (probe.mode === "user-prepared") {
          release.provider = "user-prepared";
          release.user_prepared = {};
        }
        if (probe.mode === "external") {
          const status = records(snapshot.statuses).find((entry) => entry.port_id === data.port_id);
          if (!status) throw new Error("History fixture status missing from workspace");
          status.external_runtime = {
            id: "owned-history-runtime",
            port_id: data.port_id,
            path: "owned-history-runtime",
            executable: "owned-history-runtime/game",
            version: "1.0.5",
            platform: "linux-x86-64",
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
            registered_at: 1,
          };
        }
        return snapshot;
      }
      window.fetch = async function (input, ...args) {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === inspectionUrl) {
          const body: unknown = typeof args[0]?.body === "string" ? JSON.parse(args[0].body) : null;
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !("profileId" in body) ||
            body.profileId !== data.profile_id
          )
            return original.call(window, input, ...args);
          probe.reports++;
          return new Response(JSON.stringify(data.report), {
            headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
          });
        }
        const response = await original.call(window, input, ...args);
        if (url !== snapshotUrl || !response.ok) return response;
        const snapshot = suppliedSnapshot(await response.clone().json());
        return new Response(JSON.stringify(snapshot), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      native
        .invoke("plugin:event|emit", {
          event: "portcove://library-changed",
          payload: "history-fixture",
        })
        .then(
          () => done({ ok: true }),
          (error: unknown) => done({ error: String(error) }),
        );
    },
    fixture,
  );
  assert.equal(object(installed).ok, true, JSON.stringify(installed));
}

export async function restoreHistoryScenario({
  browser,
  invoke,
  output,
  artifacts,
  observation,
  originalFont,
  originalWindow,
  primaryFailure,
  writeEvidence,
}: {
  browser: WebDriver;
  invoke: HistoryContext["invoke"];
  output: string;
  artifacts: string[];
  observation: HistoryObservation;
  originalFont: string;
  originalWindow: { width: number; height: number; x: number; y: number };
  primaryFailure?: { error: unknown };
  writeEvidence: (file: string, bytes: string, options: { flag: "wx" }) => Promise<void>;
}) {
  let validationFailure: { error: unknown } | undefined;
  let evidenceFailure: { error: unknown } | undefined;
  const restored: unknown = await browser
    .executeAsyncScript<unknown>((font: string, done: (result: unknown) => void) => {
      const host = window as HistoryWindow;
      const probe = host.__portcoveHistoryProbe;
      if (!probe) return done({ restored: true, installed: false, snapshots: 0, reports: 0 });
      window.fetch = probe.original;
      document.documentElement.style.fontSize = font;
      const result = {
        restored: window.fetch === probe.original,
        snapshots: probe.snapshots,
        reports: probe.reports,
      };
      delete host.__portcoveHistoryProbe;
      const native = host.__TAURI_INTERNALS__;
      if (!native) throw new Error("Native restoration bridge missing");
      native
        .invoke("plugin:event|emit", {
          event: "portcove://library-changed",
          payload: "history-restored",
        })
        .then(
          () => done(result),
          (error: unknown) => done({ ...result, error: String(error) }),
        );
    }, originalFont)
    .catch((error: unknown) => ({ restored: false, error: errorMessage(error) }));
  // Keep raw replies before checking them: malformed transport results must
  // not prevent the independent window/source cleanup or its evidence.
  observation.restoration = restored;
  await browser
    .manage()
    .window()
    .setRect(originalWindow)
    .catch((error: unknown) => {
      observation.window_restoration_error = errorMessage(error);
      // Preserve the existing nested evidence contract for object replies,
      // while still retaining malformed replies and independent cleanup.
      if (isRecord(restored)) restored.window_error = observation.window_restoration_error;
    });
  const nativeRaw: unknown = await invoke("get_sources").catch((error: unknown) => ({
    ok: false,
    error: errorMessage(error),
  }));
  const nativeRecord = isRecord(nativeRaw) ? nativeRaw : undefined;
  observation.native_source_restoration = nativeRecord
    ? {
        ok: nativeRecord.ok,
        ...(Array.isArray(nativeRecord.value) ? { count: nativeRecord.value.length } : {}),
        error: nativeRecord.error,
      }
    : { raw_reply: nativeRaw };
  try {
    assertHistoryRestoration(restored, nativeRaw, {
      scenarioFailed: Boolean(observation.failure),
      windowError: observation.window_restoration_error,
    });
  } catch (error) {
    validationFailure = { error };
    observation.restoration_validation_failure = { message: errorMessage(error) };
  }
  const report = path.join(output, "qualification-history.json");
  try {
    await writeEvidence(report, JSON.stringify(observation, null, 2), { flag: "wx" });
    artifacts.push(report);
  } catch (error) {
    evidenceFailure = { error };
    console.error("Could not retain qualification history evidence:", errorMessage(error));
  }
  if (primaryFailure) throw primaryFailure.error;
  if (validationFailure) throw validationFailure.error;
  if (evidenceFailure) throw evidenceFailure.error;
}

export async function qualificationHistoryScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  captureScreenshot,
}: HistoryContext) {
  await scenario("native-qualification-history", async () => {
    assert.equal(process.platform, "linux", "This bounded fixture is Linux-native evidence only");
    const catalog: unknown = JSON.parse(
      await readFile(
        new URL("../../../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const fixture = qualificationHistoryFixture(catalog);
    const originalWindow = await browser.manage().window().getRect();
    const originalFont = await executeBrowserScript(
      browser,
      () => document.documentElement.style.fontSize,
    );
    const originalComputedFont = await executeBrowserScript(
      browser,
      () => getComputedStyle(document.documentElement).fontSize,
    );
    let expectedView: HistoryView | undefined;
    const observation: HistoryObservation = {
      limitation:
        "Actual Tauri/WebKit presentation with supplied historical read responses and synthetic runtime branches; no current file qualification or physical-controller evidence",
      source_response: fixture,
      views: [],
    };
    let By: typeof import("selenium-webdriver").By;
    let Key: typeof import("selenium-webdriver").Key;
    let technicalSummary: Locator;
    const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    async function openDetails() {
      const { selectCatalogPort } = await import("./desktop-review-controls.mts");
      await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]')).click();
      await selectCatalogPort(browser, fixture.port_id);
      await browser.wait(
        async () =>
          (await browser.findElement(By.css(".detail-panel")).getText()).includes("165 Hz host"),
        15_000,
        "Populated production history did not settle; A16 component composition is required",
      );
    }
    async function expandTechnical(summary: WebElement, name: string) {
      let tabSteps = null;
      if (name === "default-dark" || ["user-prepared", "external"].includes(name)) {
        for (tabSteps = 0; tabSteps < 80; tabSteps++) {
          if (
            await executeBrowserScript(
              browser,
              (element) => document.activeElement === element,
              summary,
            )
          )
            break;
          await browser.actions().sendKeys(Key.TAB).perform();
        }
        assert.ok(
          tabSteps < 80,
          "Technical disclosure must be reachable through ordinary Tab navigation",
        );
        await browser.actions().sendKeys(Key.ENTER).perform();
      } else await summary.click();
      return tabSteps;
    }
    async function captureRecords(details: WebElement, name: string) {
      // Capture each maintained record at readable viewport scale rather than
      // accepting a single screenshot of a disclosure taller than the window.
      const records = await details.findElements(
        By.css('section[aria-label="Recorded game-file checks"] li'),
      );
      assert.equal(
        records.length,
        fixture.report.applications[0].qualification.exact_records.length,
      );
      for (const [index, record] of records.entries()) {
        const frame = await executeBrowserScript(
          browser,
          (element) => {
            element.scrollIntoView({ block: "start" });
            const bounds = element.getBoundingClientRect();
            return {
              height: bounds.height,
              viewport: innerHeight,
              horizontal_overflow: element.scrollWidth > element.clientWidth + 1,
            };
          },
          record,
        );
        assert.equal(frame.horizontal_overflow, false);
        assert.ok(
          frame.height <= frame.viewport * 2,
          "A maintained record requires more than two readable frames",
        );
        await captureScreenshot(`qualification-history-${name}-record-${index}-top`, true);
        if (frame.height > frame.viewport) {
          await executeBrowserScript(
            browser,
            (element) => element.scrollIntoView({ block: "end" }),
            record,
          );
          await captureScreenshot(`qualification-history-${name}-record-${index}-bottom`, true);
        }
      }
    }
    async function assertRenderedBranch(name: string) {
      if (!["user-prepared", "external"].includes(name)) return "managed";
      const required =
        name === "external"
          ? ["owned-history-runtime", "Stop using this installation"]
          : ["Choose game folder"];
      await browser.wait(
        async () => {
          const text = await browser.findElement(By.css(".detail-panel")).getText();
          return (
            required.every((label) => text.includes(label)) &&
            (name === "external" || !text.includes("owned-history-runtime"))
          );
        },
        15_000,
        `The actual ${name} detail branch did not settle`,
      );
      return name;
    }
    async function checkView(name: string) {
      const view = required(expectedView);
      const renderedBranch = await assertRenderedBranch(name);
      const panel = await browser.findElement(By.css(".detail-panel"));
      const text = await panel.getText();
      for (const expected of [
        "Recorded history",
        "Structural check",
        "Automated lifecycle",
        "Known failure",
        "165 Hz host",
      ])
        assert.ok(text.includes(expected), expected);
      const summary = await browser.findElement(technicalSummary);
      const tabSteps = await expandTechnical(summary, name);
      const details = await summary.findElement(By.xpath(".."));
      assert.equal(await details.getAttribute("open"), "true");
      assert.ok((await details.getText()).includes("snap64-windows-qualification-v1"));
      if (name.includes("user-prepared") || name.includes("external"))
        assert.doesNotMatch(
          await details.getText(),
          /Commands and recorded checks|Set up from the command line|Steam shortcut/,
        );
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "center" }),
        details,
      );
      const layout = await executeBrowserScript(
        browser,
        (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            viewport: { width: innerWidth, height: innerHeight },
            font_size: getComputedStyle(document.documentElement).fontSize,
            bounds: {
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
              bottom: bounds.bottom,
            },
            horizontal_overflow: element.scrollWidth > element.clientWidth + 1,
            theme: document.documentElement.dataset.theme,
          };
        },
        details,
      );
      assert.equal(layout.horizontal_overflow, false, JSON.stringify(layout));
      assert.ok(layout.bounds.left >= 0 && layout.bounds.right <= layout.viewport.width + 1);
      assert.equal(layout.theme, view.theme);
      assert.equal(layout.font_size, view.font);
      const actualWindow = await browser.manage().window().getRect();
      assert.equal(actualWindow.width, view.width);
      assert.equal(actualWindow.height, view.height);
      observation.views.push({
        name,
        rendered_branch: renderedBranch,
        expected_view: view,
        tab_steps: tabSteps,
        window: await browser.manage().window().getRect(),
        ...layout,
      });
      await captureScreenshot(`qualification-history-${name}-technical`, true);
      await captureRecords(details, name);
      await summary.sendKeys(Key.ENTER);
      assert.equal(await details.getAttribute("open"), null);
      await summary.sendKeys(Key.SPACE);
      assert.equal(await details.getAttribute("open"), "true");
      await summary.sendKeys(Key.ENTER);
      const projectSummary = await browser.findElement(
        By.xpath('//summary[normalize-space(.)="Project and compatibility details"]'),
      );
      const projectDetails = await projectSummary.findElement(By.xpath(".."));
      if ((await projectDetails.getAttribute("open")) === null) {
        await executeBrowserScript(
          browser,
          (element) => element.scrollIntoView({ block: "center" }),
          projectSummary,
        );
        await projectSummary.sendKeys(Key.ENTER);
      }
      const heading = await browser.findElement(
        By.xpath('//*[self::h2 or self::h3][normalize-space(.)="Recorded checks"]'),
      );
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "start" }),
        heading,
      );
      await captureScreenshot(`qualification-history-${name}-primary`, true);
    }
    let primaryFailure: { error: unknown } | undefined;
    try {
      await installHistoryFixture(browser, fixture);
      // Diagnostics import fixture/process helpers without desktop dependencies.
      ({ By, Key } = await import("selenium-webdriver"));
      technicalSummary = By.xpath('//summary[contains(., "Technical details")]');
      await browser.wait(
        async () =>
          (await executeBrowserScript(
            browser,
            () => (window as HistoryWindow).__portcoveHistoryProbe?.snapshots ?? 0,
          )) > 0,
        15_000,
      );
      // Catalog has no requested inspection profiles until a port is selected.
      await openDetails();
      await browser.wait(
        async () =>
          (await executeBrowserScript(
            browser,
            () => (window as HistoryWindow).__portcoveHistoryProbe?.reports ?? 0,
          )) > 0,
        15_000,
      );
      for (const [name, theme, width, height, font] of [
        ["default-dark", "Dark", 1280, 800, originalFont],
        ["compact-light", "Light", 960, 640, originalFont],
        ["text-scaled-light", "Light", 1280, 800, "20px"],
      ] as const) {
        await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
        await browser.findElement(button(theme)).click();
        await browser.wait(
          async () =>
            (await executeBrowserScript(browser, () => document.documentElement.dataset.theme)) ===
            theme.toLowerCase(),
          5_000,
        );
        expectedView = {
          theme: theme.toLowerCase(),
          width,
          height,
          font: font || originalComputedFont,
        };
        await browser.manage().window().setRect({ width, height });
        await executeBrowserScript(
          browser,
          (size) => {
            document.documentElement.style.fontSize = size;
          },
          font,
        );
        await openDetails();
        await checkView(name);
      }
      await executeBrowserScript(
        browser,
        (font) => {
          document.documentElement.style.fontSize = font;
        },
        originalFont,
      );
      expectedView = { ...required(expectedView), font: originalComputedFont };
      for (const mode of ["user-prepared", "external"]) {
        const refreshed = await browser.executeAsyncScript<unknown>(
          (next: string, done: (result: unknown) => void) => {
            const host = window as HistoryWindow;
            const probe = host.__portcoveHistoryProbe;
            const native = host.__TAURI_INTERNALS__;
            if (!probe || !native) throw new Error("Installed history probe missing");
            probe.mode = next;
            native
              .invoke("plugin:event|emit", {
                event: "portcove://library-changed",
                payload: `history-${next}`,
              })
              .then(
                () => done(true),
                (error: unknown) => done(String(error)),
              );
          },
          mode,
        );
        assert.equal(refreshed, true);
        await browser.wait(
          async () =>
            (await executeBrowserScript(
              browser,
              (next) => (window as HistoryWindow).__portcoveHistoryProbe?.modeSnapshots[next] ?? 0,
              mode,
            )) > 0,
          15_000,
          "The requested synthetic runtime branch was not read",
        );
        await openDetails();
        await checkView(mode);
      }
    } catch (error) {
      primaryFailure = { error };
      observation.failure = { message: errorMessage(error) };
    } finally {
      await restoreHistoryScenario({
        browser,
        invoke,
        output,
        artifacts,
        observation,
        originalFont,
        originalWindow,
        primaryFailure,
        writeEvidence: writeFile,
      });
    }
  });
}
