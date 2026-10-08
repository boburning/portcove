// One normal-app read-response fixture. No game launch, source registration or consent mutation.
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";

// Linux history uses the harness's existing detached driver group and SIGTERM.
// These observations add ownership/exit proof; they never signal a process.
async function historyProcess(pid) {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!raw) return null;
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z") return null;
  const executable = await readlink(`/proc/${pid}/exe`).catch((error) => {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  });
  return {
    pid: Number(pid),
    parent: Number(fields[1]),
    group: Number(fields[2]),
    start_ticks: fields[19],
    executable,
  };
}

function sameHistoryIdentity(expected, actual) {
  assert.ok(actual, `Captured native PID ${expected.pid} exited before identity validation`);
  for (const key of ["pid", "parent", "group", "start_ticks", "executable"])
    assert.equal(actual[key], expected[key], `Captured native ${key} changed`);
}

export async function captureHistorySession(driverPid, driverPath, applicationPath) {
  assert.equal(process.platform, "linux");
  const owner = await historyProcess(process.pid);
  const driver = await historyProcess(driverPid);
  assert.ok(driver && owner, "Owned history driver is not running");
  assert.equal(driver.parent, owner.pid);
  assert.equal(driver.group, driver.pid, "History driver must retain its owned detached group");
  assert.equal(driver.executable, await realpath(driverPath));
  assert.ok(BigInt(driver.start_ticks) >= BigInt(owner.start_ticks));
  const all = (
    await Promise.all(
      (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(historyProcess),
    )
  ).filter(Boolean);
  const processes = [driver];
  for (let index = 0; index < processes.length; index++) {
    const parent = processes[index];
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
  assert.ok(application, "Exact history application is not an observed driver descendant");
  for (const entry of processes) sameHistoryIdentity(entry, await historyProcess(entry.pid));
  return { owner, driver, application, processes, captured_at: new Date().toISOString() };
}

export async function historyDriverStillOwned(inventory) {
  const current = await historyProcess(inventory.driver.pid);
  if (!current) return false;
  sameHistoryIdentity(inventory.driver, current);
  return true;
}

export async function waitHistorySessionExit(inventory) {
  const deadline = Date.now() + 15_000;
  let remaining;
  do {
    remaining = [];
    for (const entry of inventory.processes) {
      const current = await historyProcess(entry.pid);
      if (current?.start_ticks === entry.start_ticks) remaining.push(entry.pid);
    }
    if (!remaining.length)
      return { all_exited: true, observed_at: new Date().toISOString(), captured: inventory };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    `Captured history processes did not exit within 15 seconds: ${remaining.join(", ")}`,
  );
}

// The repository-level scripts/desktop-scenarios.test.mjs consumes this export.
// Its test root is outside the frontend Fallow graph.
// fallow-ignore-next-line unused-export
export function qualificationHistoryFixture(catalog) {
  const port = catalog.ports.find((entry) => entry.id === "snap64-recomp");
  const source = catalog.source_catalog;
  assert.ok(port && source, "Maintained Snap64 source catalog is required");
  const contract = source.contracts.find(
    (entry) => entry.port_id === port.id && entry.role === "game",
  );
  const records = source.qualification.filter((entry) => entry.scope.port_id === port.id);
  assert.ok(port && contract && records.length, "Maintained Snap64 history is required");
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
      expected_identity: source.identities.find((entry) => entry.id === port.source_profile),
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
      ],
      evidence: [],
      legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
    },
  };
}

export async function qualificationHistoryScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  captureScreenshot,
}) {
  await scenario("native-qualification-history", async () => {
    assert.equal(process.platform, "linux", "This bounded fixture is Linux-native evidence only");
    const catalog = JSON.parse(
      await readFile(
        new URL("../../../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const fixture = qualificationHistoryFixture(catalog);
    const originalWindow = await browser.manage().window().getRect();
    const originalFont = await browser.executeScript(() => document.documentElement.style.fontSize);
    const originalComputedFont = await browser.executeScript(
      () => getComputedStyle(document.documentElement).fontSize,
    );
    let expectedView;
    const observation = {
      limitation:
        "Actual Tauri/WebKit presentation with supplied historical read responses and synthetic runtime branches; no current file qualification or physical-controller evidence",
      source_response: fixture,
      views: [],
    };
    async function installFixture() {
      const installed = await browser.executeAsyncScript((data, done) => {
        const native = window.__TAURI_INTERNALS__;
        const original = window.fetch;
        const snapshotUrl = native.convertFileSrc("get_workspace_snapshot", "ipc");
        const inspectionUrl = native.convertFileSrc("inspect_source", "ipc");
        const probe = {
          original,
          data,
          mode: "managed",
          snapshots: 0,
          reports: 0,
          modeSnapshots: {},
        };
        window.__portcoveHistoryProbe = probe;
        function suppliedSnapshot(snapshot) {
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
          const port = snapshot.catalog.ports.find((entry) => entry.id === data.port_id);
          if (probe.mode === "user-prepared") {
            port.release.provider = "user-prepared";
            port.release.user_prepared = {};
          }
          if (probe.mode === "external") {
            const status = snapshot.statuses.find((entry) => entry.port_id === data.port_id);
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
          const url = typeof input === "string" ? input : input.url;
          if (url === inspectionUrl) {
            const body = typeof args[0]?.body === "string" ? JSON.parse(args[0].body) : null;
            if (body?.profileId !== data.profile_id) return original.call(window, input, ...args);
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
            (error) => done({ error: String(error) }),
          );
      }, fixture);
      assert.equal(installed.ok, true, JSON.stringify(installed));
    }
    const technicalSummary = By.xpath('//summary[contains(., "Technical details")]');
    const button = (label) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    async function openDetails() {
      await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
      const card = await browser.wait(
        until.elementLocated(
          By.css(`button[data-detail-origin="catalog:card:${fixture.port_id}"]`),
        ),
        15_000,
      );
      await card.click();
      await browser.wait(
        async () =>
          (await browser.findElement(By.css(".detail-panel")).getText()).includes("165 Hz host"),
        15_000,
        "Populated production history did not settle; A16 component composition is required",
      );
    }
    async function expandTechnical(summary, name) {
      let tabSteps = null;
      if (name === "default-dark" || ["user-prepared", "external"].includes(name)) {
        for (tabSteps = 0; tabSteps < 80; tabSteps++) {
          if (await browser.executeScript((element) => document.activeElement === element, summary))
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
    async function captureRecords(details, name) {
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
        const frame = await browser.executeScript((element) => {
          element.scrollIntoView({ block: "start" });
          const bounds = element.getBoundingClientRect();
          return {
            height: bounds.height,
            viewport: innerHeight,
            horizontal_overflow: element.scrollWidth > element.clientWidth + 1,
          };
        }, record);
        assert.equal(frame.horizontal_overflow, false);
        assert.ok(
          frame.height <= frame.viewport * 2,
          "A maintained record requires more than two readable frames",
        );
        await captureScreenshot(`qualification-history-${name}-record-${index}-top`, true);
        if (frame.height > frame.viewport) {
          await browser.executeScript(
            (element) => element.scrollIntoView({ block: "end" }),
            record,
          );
          await captureScreenshot(`qualification-history-${name}-record-${index}-bottom`, true);
        }
      }
    }
    async function assertRenderedBranch(name) {
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
    async function checkView(name) {
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
          /Commands and maintenance|Set up from the command line|Steam shortcut/,
        );
      await browser.executeScript(
        (element) => element.scrollIntoView({ block: "center" }),
        details,
      );
      const layout = await browser.executeScript((element) => {
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
      }, details);
      assert.equal(layout.horizontal_overflow, false, JSON.stringify(layout));
      assert.ok(layout.bounds.left >= 0 && layout.bounds.right <= layout.viewport.width + 1);
      assert.equal(layout.theme, expectedView.theme);
      assert.equal(layout.font_size, expectedView.font);
      const actualWindow = await browser.manage().window().getRect();
      assert.equal(actualWindow.width, expectedView.width);
      assert.equal(actualWindow.height, expectedView.height);
      observation.views.push({
        name,
        rendered_branch: renderedBranch,
        expected_view: expectedView,
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
      const heading = await browser.findElement(
        By.xpath('//*[self::h2 or self::h3][normalize-space(.)="Compatibility and testing"]'),
      );
      await browser.executeScript((element) => element.scrollIntoView({ block: "start" }), heading);
      await captureScreenshot(`qualification-history-${name}-primary`, true);
    }
    try {
      await installFixture();
      await browser.wait(
        async () =>
          (await browser.executeScript(() => window.__portcoveHistoryProbe?.reports ?? 0)) > 0,
        15_000,
      );
      for (const [name, theme, width, height, font] of [
        ["default-dark", "Dark", 1280, 800, originalFont],
        ["compact-light", "Light", 960, 640, originalFont],
        ["text-scaled-light", "Light", 1280, 800, "20px"],
      ]) {
        await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
        await browser.findElement(button(theme)).click();
        await browser.wait(
          async () =>
            (await browser.executeScript(() => document.documentElement.dataset.theme)) ===
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
        await browser.executeScript((size) => {
          document.documentElement.style.fontSize = size;
        }, font);
        await openDetails();
        await checkView(name);
      }
      await browser.executeScript((font) => {
        document.documentElement.style.fontSize = font;
      }, originalFont);
      expectedView = { ...expectedView, font: originalComputedFont };
      for (const mode of ["user-prepared", "external"]) {
        const refreshed = await browser.executeAsyncScript((next, done) => {
          window.__portcoveHistoryProbe.mode = next;
          window.__TAURI_INTERNALS__
            .invoke("plugin:event|emit", {
              event: "portcove://library-changed",
              payload: `history-${next}`,
            })
            .then(
              () => done(true),
              (error) => done(String(error)),
            );
        }, mode);
        assert.equal(refreshed, true);
        await browser.wait(
          async () =>
            (await browser.executeScript(
              (next) => window.__portcoveHistoryProbe.modeSnapshots[next] ?? 0,
              mode,
            )) > 0,
          15_000,
          "The requested synthetic runtime branch was not read",
        );
        await openDetails();
        await checkView(mode);
      }
    } catch (error) {
      observation.failure = { message: error.message };
      throw error;
    } finally {
      observation.restoration = await browser.executeAsyncScript((font, done) => {
        const probe = window.__portcoveHistoryProbe;
        if (!probe) return done({ restored: true, installed: false, snapshots: 0, reports: 0 });
        window.fetch = probe.original;
        document.documentElement.style.fontSize = font;
        const result = {
          restored: window.fetch === probe.original,
          snapshots: probe.snapshots,
          reports: probe.reports,
        };
        delete window.__portcoveHistoryProbe;
        window.__TAURI_INTERNALS__
          .invoke("plugin:event|emit", {
            event: "portcove://library-changed",
            payload: "history-restored",
          })
          .then(
            () => done(result),
            (error) => done({ ...result, error: String(error) }),
          );
      }, originalFont);
      await browser.manage().window().setRect(originalWindow);
      const report = path.join(output, "qualification-history.json");
      await writeFile(report, JSON.stringify(observation, null, 2), { flag: "wx" });
      artifacts.push(report);
      assert.equal(observation.restoration.restored, true);
      if (!observation.failure && observation.restoration.installed !== false)
        assert.ok(observation.restoration.snapshots > 0 && observation.restoration.reports > 0);
      assert.equal(observation.restoration.error, undefined);
      const nativeSources = await invoke("get_sources");
      assert.equal(nativeSources.ok, true);
      assert.equal(
        nativeSources.value.length,
        0,
        "Synthetic responses must not register source data",
      );
    }
  });
}
