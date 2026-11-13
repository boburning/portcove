// Owned inert native inputs; actual Core inspection and generation refusal.
// The library handoff uses the first-party IPC command plus a normal renderer
// reload. It does not claim a physical library-picker interaction or gameplay.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { By, until, type WebDriver } from "selenium-webdriver";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import { fixtureObject as object } from "./desktop-scenario-state.mts";
import type { createInstallFixture } from "./desktop-install-fixture.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { transportValue, transportValues } from "./transport-values.mts";
import {
  captureAccessibilityReport,
  clickVisible,
  openCatalogPortAfterRefresh,
  revealDetailSection,
  reviewControls,
} from "./desktop-review-controls.mts";
import { executeBrowserScript } from "./browser-script.mts";

export function staleSourceImportScript(
  request: Record<string, unknown>,
  done: (result: string) => void,
) {
  const native = (
    window as Window & {
      __TAURI_INTERNALS__?: {
        transformCallback(f: (value: unknown) => void, once: boolean): number;
        unregisterCallback(id: number): void;
        invoke(command: string, args: object): Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__;
  if (!native) throw Error("Native IPC unavailable");
  const channel_frames: unknown[] = [];
  let closeChannel!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeChannel = resolve;
  });
  const id = native.transformCallback((value) => {
    channel_frames.push(value);
    if (value !== null && typeof value === "object" && "end" in value) closeChannel();
  }, false);
  void native
    .invoke("import_source", { ...request, onEvent: `__CHANNEL__:${id}` })
    .then(
      (value) => ({ ok: true, value, channel_frames }),
      (error: unknown) => ({ ok: false, error, channel_frames }),
    )
    .then(async (result) => {
      // The existing WebDriver script deadline bounds this wait. Observe the
      // entire channel through closure before asserting absence of data.
      await closed;
      native.unregisterCallback(id);
      done(JSON.stringify(result));
    });
}

export function assertStaleSourceImportReply(stale: Record<string, unknown>) {
  assert.equal(stale.ok, false);
  assert.equal(object(stale.error).code, "conflict");
  assert.deepEqual(
    stale.channel_frames,
    [{ index: 0, end: true }],
    "A stale import must close its channel before sending any application frame",
  );
}

export async function sourceIntakeNativeBoundaries({
  browser,
  invoke,
  library,
  output,
  artifacts,
  command,
  fixture,
  confirmNative,
}: {
  browser: WebDriver;
  invoke: ScenarioInvoke;
  library: string;
  output: string;
  artifacts: string[];
  command: FixtureCommand;
  fixture: Awaited<ReturnType<typeof createInstallFixture>>;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}) {
  assert.equal(process.platform, "win32");
  assert.ok(fixture.sourceJourney);
  const owned = fixture.sourceJourney;
  const profileId = owned.profiles[0];
  const other = path.join(output, "intake-other-library");
  await mkdir(other);
  const selected = [owned.gamePath, owned.ambiguousPath, owned.unsupportedPath];
  const originals = await Promise.all(selected.map((p) => readFile(p)));
  const sources = () => transportValues("source", command(["source", "list"]));
  const before = sources();
  const observed: Record<string, unknown> = {
    method:
      "actual native Core/UI input checks; IPC handoff plus renderer reload; inert fixtures only",
  };
  const { button, click } = reviewControls(browser);
  const dialog = By.css('[aria-labelledby="source-intake-title"]');
  let switched = false;
  let primaryFailure: unknown;
  let restoreFailure: unknown;
  let artifactFailure: unknown;
  const success = (response: unknown) => {
    const r = object(response);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.value;
  };
  const bootstrap = async () =>
    transportValue("desktop_bootstrap_status", success(await invoke("get_bootstrap_status")));
  const capture = async (name: string) => {
    const image = path.join(output, name + ".png");
    await writeFile(image, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(image);
    await captureAccessibilityReport(
      browser,
      path.join(output, name + "-accessibility.json"),
      artifacts,
    );
  };
  try {
    await openCatalogPortAfterRefresh(browser, fixture.port);
    await revealDetailSection(browser, "Game files");
    const disclosure = await browser.findElement(By.css(".requirements-disclosure"));
    if (
      !(await executeBrowserScript(
        browser,
        (element: Element) => (element as HTMLDetailsElement).open,
        disclosure,
      ))
    )
      await clickVisible(browser, await disclosure.findElement(By.css("summary")));
    await click(button("Check game files"));
    await browser.wait(until.elementLocated(dialog), 15000);
    const generation = (await bootstrap()).generation;
    for (const [name, selectedPath, state] of [
      ["ambiguous", owned.ambiguousPath, "ambiguous_identity"],
      ["unsupported", owned.unsupportedPath, "unsupported_shape"],
    ] as const) {
      const core = transportValue(
        "source_intake_inspection",
        success(await invoke("inspect_source_intake", { profileId, paths: [selectedPath] })),
      );
      assert.equal(core.state_code, state);
      await click(button("Choose game files to check"));
      await confirmNative(
        "Choose game files",
        "Open",
        "File name:",
        `selected-intake-${name}-picker`,
        selectedPath,
      );
      await browser.wait(async () => {
        const text = await browser.findElement(dialog).getText();
        return text.includes(core.summary) && text.includes(core.next_action);
      }, 15000);
      assert.equal(
        (
          await browser
            .findElement(dialog)
            .findElements(
              By.xpath(
                './/button[normalize-space(.)="Copy into Portcove" or normalize-space(.)="Use current location"]',
              ),
            )
        ).length,
        0,
      );
      assert.deepEqual(sources(), before);
      observed[name] = core;
      await capture(`selected-intake-${name}`);
    }
    await click(button("Choose game files to check"));
    await confirmNative(
      "Choose game files",
      "Open",
      "File name:",
      "selected-intake-valid-picker",
      owned.gamePath,
    );
    const valid = transportValue(
      "source_intake_inspection",
      success(await invoke("inspect_source_intake", { profileId, paths: [owned.gamePath] })),
    );
    assert.equal(valid.state_code, "recognized_exact");
    observed.valid = valid;
    await browser.wait(until.elementLocated(button("Use current location")), 15000);
    await click(button("Use current location"));
    await browser.wait(until.elementLocated(By.css('[aria-label="Source import review"]')), 15000);
    const plan = transportValue(
      "source_import_plan",
      success(
        await invoke("plan_source_import", {
          profileId,
          path: owned.gamePath,
          mode: "use_current_location",
        }),
      ),
    );
    await capture("selected-intake-before-library-switch");
    // Mark attempted handoff before awaiting it so failure cleanup reopens the
    // original library even if a response is lost after the host applied it.
    switched = true;
    success(await invoke("set_default_library", { path: other }));
    const next = await bootstrap();
    assert.ok(next.generation > generation);
    const stale = object(
      JSON.parse(
        String(
          await browser.executeAsyncScript(staleSourceImportScript, {
            generation,
            profileId,
            path: owned.gamePath,
            mode: "use_current_location",
            expectedPlan: plan.plan_sha256,
          }),
        ),
      ),
    );
    observed.stale_import = stale;
    assertStaleSourceImportReply(stale);
    assert.deepEqual(transportValues("source", command(["source", "list"], other)), []);
    assert.deepEqual(sources(), before);
    await browser.navigate().refresh();
    await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15000);
    assert.equal((await browser.findElements(dialog)).length, 0);
    assert.equal(
      (await browser.findElements(By.css('[aria-label="Source import review"]'))).length,
      0,
    );
    await capture("selected-intake-after-library-switch");
    observed.library_switch = {
      before: generation,
      after: next.generation,
      stale_request: stale,
      no_old_review: true,
      no_new_registration: true,
    };
  } catch (error) {
    primaryFailure = error;
    observed.failure = String(error);
  } finally {
    try {
      if (switched) {
        success(await invoke("set_default_library", { path: library }));
        await browser.navigate().refresh();
        await browser.wait(
          until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
          15000,
        );
      }
      assert.deepEqual(sources(), before);
      for (let i = 0; i < selected.length; i++)
        assert.deepEqual(await readFile(selected[i]!), originals[i]);
      observed.originals_and_registration_preserved = true;
    } catch (error) {
      restoreFailure = error;
      observed.restore_failure = String(error);
    }
    const receipt = path.join(output, "source-intake-native-boundaries.json");
    try {
      await writeFile(receipt, JSON.stringify(observed, null, 2), { flag: "wx" });
      artifacts.push(receipt);
    } catch (error) {
      artifactFailure = error;
    }
  }
  const failures = [primaryFailure, restoreFailure, artifactFailure].filter(
    (error) => error !== undefined,
  );
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Native source boundary check, restoration or evidence publication failed",
    );
  if (failures.length === 1) {
    const failure = failures[0];
    if (failure instanceof Error) throw failure;
    throw new Error("Native source boundary check failed", { cause: failure });
  }
  return observed;
}
