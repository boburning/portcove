import {
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { WebDriver } from "selenium-webdriver";
import type {
  PortDefinition,
  PortStatus,
  SourceRecord,
} from "../src/transport-types.generated.d.ts";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import { transportValue, transportValues } from "./transport-values.mts";
interface ReadinessContext extends ScenarioContext {
  command: FixtureCommand;
  open: (port: PortDefinition, refresh?: boolean) => Promise<unknown>;
}
interface HoldProbe {
  original: typeof fetch;
  injected: number;
  originalAvailability: string | null;
}
interface ReadinessWindow extends Window {
  __TAURI_INTERNALS__?: {
    convertFileSrc(command: string, protocol: string): string;
    invoke(command: string, args: unknown): Promise<unknown>;
  };
  __portcoveActionHoldProbe?: HoldProbe;
  __portcoveReadinessProbe?: { original: typeof fetch; injected: number };
}
interface ProbeObservation {
  injected: number;
  restored: boolean;
}
interface HoldObservation extends ProbeObservation {
  originalAvailability: string | null;
}
interface HeldObservations {
  injection: string;
  launch_before: PortStatus;
  launch_during?: PortStatus;
  launch_probe?: HoldObservation;
  install_before?: PortStatus;
  install_during?: PortStatus;
  install_after?: PortStatus;
  sources_before?: SourceRecord[];
  selected_source?: string;
  review_text?: string;
  install_probe?: HoldObservation;
  failure?: string;
}
type HoldContext = Pick<ReadinessContext, "browser" | "output" | "artifacts" | "command"> & {
  port: PortDefinition;
};
function readinessCommand(command: FixtureCommand) {
  function read(args: ["catalog", "show", string]): PortDefinition;
  function read(args: ["status", string]): PortStatus;
  function read(args: ["source", "list"]): SourceRecord[];
  function read(args: string[]) {
    const value = command(args);
    if (args[0] === "catalog") return transportValue("port", value);
    if (args[0] === "status") return transportValue("status", value);
    if (args[0] === "source") return transportValues("source", value);
    throw new Error("Unknown readiness observation command");
  }
  return read;
}
import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";
import {
  captureAccessibilityReport,
  openCatalogPortAfterRefresh,
  reviewControls,
} from "./desktop-review-controls.mts";

async function injectActionHold(browser: WebDriver, portId: string, action: string) {
  const result = object(
    await browser.executeAsyncScript<unknown>(
      (portId: string, action: string, done: (result: unknown) => void) => {
        const runtime = window as ReadinessWindow;
        const native = runtime.__TAURI_INTERNALS__;
        if (!native) throw new Error("Native bridge unavailable");
        const original = window.fetch;
        const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
        runtime.__portcoveActionHoldProbe = { original, injected: 0, originalAvailability: null };
        window.fetch = async function (input, ...args) {
          const response = await original.call(window, input, ...args);
          const url =
            typeof input === "string"
              ? input
              : input !== null &&
                  (typeof input === "object" || typeof input === "function") &&
                  "url" in input &&
                  input.url !== undefined &&
                  input.url !== null
                ? input.url
                : // oxlint-disable-next-line typescript/no-base-to-string -- Preserve native fetch coercion for foreign-realm URLs; covered by serialized-input controls.
                  String(input);
          if (url !== target || !response.ok) return response;
          const snapshot: unknown = await response.clone().json();
          const record = (value: unknown): value is Record<string, unknown> =>
            value !== null && typeof value === "object" && !Array.isArray(value);
          if (!record(snapshot) || !Array.isArray(snapshot.statuses)) return response;
          const statuses: unknown[] = snapshot.statuses;
          const status = statuses.find(
            (item): item is Record<string, unknown> => record(item) && item.port_id === portId,
          );
          if (!status || !Array.isArray(status.port_actions)) return response;
          const assessments: unknown[] = status.port_actions;
          const matches = assessments.filter(
            (item): item is Record<string, unknown> => record(item) && item.action === action,
          );
          const match = matches[0];
          if (matches.length !== 1 || !match || typeof match.availability !== "string")
            return response;
          const probe = runtime.__portcoveActionHoldProbe;
          if (!probe) return response;
          probe.injected++;
          probe.originalAvailability ??= match.availability;
          return new Response(
            JSON.stringify({
              ...snapshot,
              statuses: statuses.map((item) =>
                record(item) && item.port_id === portId && Array.isArray(item.port_actions)
                  ? {
                      ...item,
                      port_actions: (item.port_actions as unknown[]).map((assessment) =>
                        record(assessment) && assessment.action === action
                          ? {
                              ...assessment,
                              availability: "held",
                              reason: "definition_ineligible",
                              definition: { outcome: "hold", reason: "publisher_revoked" },
                            }
                          : assessment,
                      ),
                    }
                  : item,
              ),
            }),
            { status: response.status, statusText: response.statusText, headers: response.headers },
          );
        };
        void native
          .invoke("plugin:event|emit", {
            event: "portcove://library-changed",
            payload: `action-hold-probe-${action}`,
          })
          .then(
            () => done({ ok: true }),
            (error: unknown) => done({ error: String(error) }),
          );
      },
      portId,
      action,
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}

async function restoreActionHold(
  browser: WebDriver,
  expectedAvailability: string,
): Promise<HoldObservation> {
  const result = object(
    await browser.executeAsyncScript<unknown>((done: (result: unknown) => void) => {
      const runtime = window as ReadinessWindow;
      const probe = runtime.__portcoveActionHoldProbe;
      if (!probe) return done({ installed: false });
      window.fetch = probe.original;
      delete runtime.__portcoveActionHoldProbe;
      const observation = {
        injected: probe.injected,
        originalAvailability: probe.originalAvailability,
        restored: window.fetch === probe.original,
      };
      const native = runtime.__TAURI_INTERNALS__;
      if (!native) throw new Error("Native bridge unavailable");
      void native
        .invoke("plugin:event|emit", {
          event: "portcove://library-changed",
          payload: "action-hold-probe-restored",
        })
        .then(
          () => done(observation),
          (error: unknown) => done({ ...observation, error: String(error) }),
        );
    }),
  );
  assert.equal(result.restored, true, JSON.stringify(result));
  assert.ok(
    typeof result.injected === "number" && result.injected > 0,
    "The held assessment must reach an actual native snapshot",
  );
  assert.equal(result.originalAvailability, expectedAvailability);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.ok(typeof result.originalAvailability === "string");
  return {
    ...result,
    injected: result.injected,
    restored: true,
    originalAvailability: result.originalAvailability,
  };
}

async function observeHeldLaunch({
  browser,
  output,
  artifacts,
  command: rawCommand,
  port,
  held,
}: HoldContext & { held: HeldObservations }) {
  const command = readinessCommand(rawCommand);
  try {
    await injectActionHold(browser, port.id, "launch");
    await browser.wait(
      async () =>
        (await browser.findElement(By.css(".detail-panel")).getText()).includes(
          "Launch is on hold. The catalog publisher was revoked.",
        ),
      10_000,
    );
    const play = await browser.findElement(By.css(".detail-panel .primary-actions button"));
    assert.equal(await play.getText(), "Play unavailable");
    assert.equal(await play.isEnabled(), false);
    const screenshot = path.join(output, "native-held-launch.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await captureAccessibilityReport(
      browser,
      path.join(output, "held-launch-accessibility.json"),
      artifacts,
    );
    held.launch_during = command(["status", port.id]);
    assert.equal(required(held.launch_during.active).id, required(held.launch_before.active).id);
    assert.equal(held.launch_during.successful_launches, held.launch_before.successful_launches);
  } finally {
    held.launch_probe = await restoreActionHold(browser, "allowed");
  }
  await browser.wait(async () => {
    const play = await browser.findElement(By.css(".detail-panel .primary-actions button"));
    return (await play.getText()) === "Try launch" && (await play.isEnabled());
  }, 10_000);
}

async function observeHeldInstall({
  browser,
  output,
  artifacts,
  command: rawCommand,
  port,
  held,
}: HoldContext & { held: HeldObservations }) {
  const command = readinessCommand(rawCommand);
  const controls = reviewControls(browser);
  const openPete = command(["catalog", "show", "openpete"]);
  held.install_before = command(["status", openPete.id]);
  held.sources_before = command(["source", "list"]);
  assert.equal(held.install_before.active ?? null, null);
  const selectedSource = path.join(output, "owned-openpete-selection.iso");
  await writeFile(selectedSource, "inert source selection; no game data", { flag: "wx" });
  held.selected_source = selectedSource;
  await openCatalogPortAfterRefresh(browser, openPete, openPete.name);
  const sourceInput = await browser.findElement(By.id("source-spyro-dragon-openpete"));
  await sourceInput.clear();
  await sourceInput.sendKeys(selectedSource);
  await controls.click(controls.button("Review installation"));
  const installDialog = By.css('[aria-labelledby="install-review-title"]');
  await browser.wait(until.elementLocated(installDialog), 15_000);
  held.review_text = await browser.findElement(installDialog).getText();
  assert.match(held.review_text, /v0\.1\.4/);
  assert.match(held.review_text, /Install folder/);
  try {
    await injectActionHold(browser, openPete.id, "install");
    await browser.wait(
      async () =>
        (await browser.findElements(installDialog)).length === 0 &&
        (await browser.findElement(By.css(".detail-panel")).getText()).includes(
          "Setup is on hold. The catalog publisher was revoked.",
        ),
      10_000,
    );
    const primary = await browser.findElement(By.css(".detail-panel .primary-actions button"));
    assert.equal(await primary.getText(), "Installation unavailable");
    assert.equal(await primary.isEnabled(), false);
    const cancel = await browser.findElement(controls.button("Cancel review"));
    assert.equal(await cancel.isEnabled(), true);
    const screenshot = path.join(output, "native-held-install-review-dismissed.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await captureAccessibilityReport(
      browser,
      path.join(output, "held-install-accessibility.json"),
      artifacts,
    );
    await controls.click(controls.button("Cancel review"));
    await browser.wait(
      async () => (await browser.findElements(controls.button("Cancel review"))).length === 0,
      5_000,
    );
    held.install_during = command(["status", openPete.id]);
    assert.equal(held.install_during.active ?? null, null);
    assert.deepEqual(command(["source", "list"]), held.sources_before);
  } finally {
    held.install_probe = await restoreActionHold(browser, "waiting");
  }
  await browser.wait(async () => {
    const reviews = await browser.findElements(controls.button("Review installation"));
    return reviews.length === 1 && (await required(reviews[0]).isEnabled());
  }, 10_000);
  await controls.click(controls.button("Review installation"));
  await browser.wait(until.elementLocated(installDialog), 15_000);
  await controls.click(controls.button("Cancel review"));
  held.install_after = command(["status", openPete.id]);
  assert.equal(held.install_after.active ?? null, null);
  assert.deepEqual(command(["source", "list"]), held.sources_before);
  assert.equal(
    command(["status", port.id]).successful_launches,
    held.launch_before.successful_launches,
  );
}

async function observeActionHolds({ browser, output, artifacts, command, port }: HoldContext) {
  const held: HeldObservations = {
    injection: "replace one assessed action in actual native workspace snapshots only",
    launch_before: readinessCommand(command)(["status", port.id]),
  };
  try {
    await observeHeldLaunch({ browser, output, artifacts, command, port, held });
    await observeHeldInstall({ browser, output, artifacts, command, port, held });
  } catch (error) {
    held.failure = errorMessage(error);
    throw error;
  } finally {
    const report = path.join(output, "native-action-hold-observations.json");
    await writeFile(report, JSON.stringify(held, null, 2), { flag: "wx" });
    artifacts.push(report);
  }
}

async function detailLayout(browser: WebDriver, summary: string) {
  return executeBrowserScript(
    browser,
    (expectedSummary) => {
      const detail = document.querySelector(".detail-panel");
      const bounds = (selector: string) => detail?.querySelector(selector)?.getBoundingClientRect();
      const summaryParagraph = [
        ...(detail?.querySelectorAll('section[aria-labelledby="detail-about-this-port"] p') ?? []),
      ].find((paragraph) => paragraph.textContent?.trim() === expectedSummary);
      return {
        state: detail?.querySelector(".detail-hero .hero-state")?.textContent?.trim(),
        reason: detail?.querySelector(".detail-hero .hero-reason")?.textContent?.trim(),
        hasReason: Boolean(detail?.querySelector(".detail-hero .hero-reason")),
        actionInHero: Boolean(
          detail
            ?.querySelector(".detail-hero")
            ?.contains(detail.querySelector(".primary-actions button")),
        ),
        reasonBottom: bounds(".detail-hero .hero-reason")?.bottom,
        heroBottom: bounds(".detail-hero")?.bottom,
        actionTop: bounds(".primary-actions button")?.top,
        actionBottom: bounds(".primary-actions button")?.bottom,
        summaryTop: summaryParagraph?.getBoundingClientRect().top,
        artworkTop: bounds(".artwork-controls")?.top,
        viewportHeight: window.innerHeight,
      };
    },
    summary,
  );
}

type DetailLayout = Awaited<ReturnType<typeof detailLayout>>;
type Measurement =
  | "reasonBottom"
  | "heroBottom"
  | "actionTop"
  | "actionBottom"
  | "summaryTop"
  | "artworkTop";
function assertMeasured<Name extends Measurement>(
  layout: DetailLayout,
  names: Name[],
): asserts layout is DetailLayout & Record<Name, number> {
  for (const name of names)
    assert.ok(
      typeof layout[name] === "number" && Number.isFinite(layout[name]),
      `${name} is missing: ${JSON.stringify(layout)}`,
    );
}

async function assertUnavailableLayout(browser: WebDriver, summary: string) {
  const layout = await detailLayout(browser, summary);
  assert.equal(layout.state, "Readiness unavailable");
  assert.equal(
    layout.reason,
    "Current launch readiness is unavailable. Reopen Portcove to check again.",
  );
  assertMeasured(layout, ["reasonBottom", "actionTop", "summaryTop"]);
  assert.ok(layout.reasonBottom <= layout.actionTop, JSON.stringify(layout));
  assert.ok(layout.actionTop < layout.summaryTop, JSON.stringify(layout));
}

async function assertTrialLayout(browser: WebDriver, summary: string) {
  const layout = await detailLayout(browser, summary);
  assert.equal(layout.state, "Compatibility unconfirmed");
  assert.equal(
    layout.reason,
    "The files are available, but this edition has not been confirmed for the installed version. Try launch to let the port check them; setup may still be needed.",
  );
  assertMeasured(layout, [
    "reasonBottom",
    "heroBottom",
    "actionTop",
    "actionBottom",
    "summaryTop",
    "artworkTop",
  ]);
  assert.ok(layout.reasonBottom <= layout.actionTop, JSON.stringify(layout));
  assert.equal(layout.actionInHero, true, JSON.stringify(layout));
  assert.ok(layout.actionTop >= 0, JSON.stringify(layout));
  assert.ok(layout.actionBottom <= layout.viewportHeight, JSON.stringify(layout));
  assert.ok(layout.actionBottom <= layout.summaryTop, JSON.stringify(layout));
  assert.ok(layout.actionBottom < layout.artworkTop, JSON.stringify(layout));
  assert.equal(layout.hasReason, true, JSON.stringify(layout));
}

export async function readinessScenario({
  browser,
  scenario,
  output,
  artifacts,
  command: rawCommand,
  open,
}: ReadinessContext) {
  const command = readinessCommand(rawCommand);
  await scenario("native-missing-readiness-recovery", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const before = command(["status", port.id]);
    assert.equal(required(before.readiness).launchable, true);
    const observations: {
      injection: string;
      before: PortStatus;
      after_review?: PortStatus;
      failure?: string;
      probe?: ProbeObservation | { installed: false };
    } = {
      injection:
        "omit one owned port's readiness from actual get_workspace_snapshot responses; core remains launchable",
      before,
    };
    const controls = reviewControls(browser);
    await open(port, false);
    try {
      await browser
        .executeAsyncScript<unknown>((portId: string, done: (result: unknown) => void) => {
          const runtime = window as ReadinessWindow;
          const native = runtime.__TAURI_INTERNALS__;
          if (!native) throw new Error("Native bridge unavailable");
          const original = window.fetch;
          const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
          runtime.__portcoveReadinessProbe = { original, injected: 0 };
          window.fetch = async function (input, ...args) {
            const url =
              typeof input === "string"
                ? input
                : input !== null &&
                    (typeof input === "object" || typeof input === "function") &&
                    "url" in input &&
                    input.url !== undefined &&
                    input.url !== null
                  ? input.url
                  : // oxlint-disable-next-line typescript/no-base-to-string -- Preserve native fetch coercion for foreign-realm URLs; covered by serialized-input controls.
                    String(input);
            const response = await original.call(window, input, ...args);
            if (url !== target) return response;
            const snapshot: unknown = await response.clone().json();
            const record = (value: unknown): value is Record<string, unknown> =>
              value !== null && typeof value === "object" && !Array.isArray(value);
            if (!record(snapshot)) return response;
            if (
              !Array.isArray(snapshot.statuses) ||
              !snapshot.statuses.some(
                (status: unknown) =>
                  record(status) &&
                  status.port_id === portId &&
                  record(status.readiness) &&
                  status.readiness.launchable === true,
              )
            )
              return response;
            const probe = runtime.__portcoveReadinessProbe;
            if (!probe) return response;
            probe.injected++;
            return new Response(
              JSON.stringify({
                ...snapshot,
                statuses: (snapshot.statuses as unknown[]).map((status) =>
                  record(status) && status.port_id === portId
                    ? { ...status, readiness: null }
                    : status,
                ),
              }),
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              },
            );
          };
          void native
            .invoke("plugin:event|emit", {
              event: "portcove://library-changed",
              payload: "readiness-probe",
            })
            .then(
              () => done({ ok: true }),
              (error: unknown) => done({ error }),
            );
        }, port.id)
        .then((value) => {
          const result = object(value);
          assert.equal(result.ok, true, JSON.stringify(result));
        });
      await browser.wait(
        async () =>
          (await browser.findElement(By.css(".detail-panel")).getText()).includes(
            "Readiness unavailable",
          ),
        10_000,
      );
      const primary = await browser.findElement(By.css(".detail-panel .primary-actions button"));
      assert.equal(await primary.isEnabled(), false);
      assert.equal(await primary.getText(), "Play unavailable");
      await assertUnavailableLayout(browser, port.summary);
      await captureAccessibilityReport(
        browser,
        path.join(output, "readiness-accessibility.json"),
        artifacts,
      );
      const screenshot = path.join(output, "native-readiness-unavailable.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await controls.click(By.css(".detail-back"));
      await controls.click(controls.button("Review launch"));
      await browser.wait(until.elementLocated(By.css(".detail-panel")), 10_000);
      await browser.wait(
        async () =>
          (await browser.findElement(By.css(".detail-panel")).getText()).includes(
            "Readiness unavailable",
          ),
        10_000,
      );
      observations.after_review = command(["status", port.id]);
      assert.equal(required(observations.after_review.readiness).launchable, true);
      assert.equal(required(observations.after_review.active).id, required(before.active).id);
      assert.equal(observations.after_review.successful_launches, before.successful_launches);
    } catch (error) {
      observations.failure = errorMessage(error);
      throw error;
    } finally {
      try {
        observations.probe = await executeBrowserScript(browser, () => {
          const runtime = window as ReadinessWindow;
          const probe = runtime.__portcoveReadinessProbe;
          if (!probe) return { installed: false };
          window.fetch = probe.original;
          const result = {
            injected: probe.injected,
            restored: window.fetch === probe.original,
          };
          delete runtime.__portcoveReadinessProbe;
          return result;
        });
        assert.ok("restored" in observations.probe && observations.probe.restored === true);
      } finally {
        const report = path.join(output, "readiness-observations.json");
        await writeFile(report, JSON.stringify(observations, null, 2), {
          flag: "wx",
        });
        artifacts.push(report);
      }
    }
    assert.ok(
      observations.probe && "injected" in observations.probe && observations.probe.injected > 0,
      "The native omission must actually reach the renderer",
    );
    await open(port, false);
    await browser.wait(
      until.elementLocated(By.css(".detail-panel .primary-actions button")),
      10_000,
    );
    await browser.wait(
      async () =>
        (await browser.findElement(By.css(".detail-panel .primary-actions button")).getText()) ===
        "Try launch",
      10_000,
    );
    assert.equal(
      await browser.findElement(By.css(".detail-panel .primary-actions button")).isEnabled(),
      true,
    );
    const readyImage = path.join(output, "native-ready-next-action.png");
    await writeFile(readyImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(readyImage);
    await assertTrialLayout(browser, port.summary);
    assert.equal(command(["status", port.id]).successful_launches, before.successful_launches);
    if (process.platform === "win32")
      await observeActionHolds({ browser, output, artifacts, command: rawCommand, port });
  });
}
