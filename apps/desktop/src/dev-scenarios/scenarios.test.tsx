// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedScenarioAction, renderScenario, scenarios } from "./scenarios";

const invoke = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected native invocation");
  }),
);
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke }));

describe("static development scenarios", () => {
  it("renders every typed scenario deterministically without invoking native actions", () => {
    for (const scenario of scenarios) {
      const html = renderScenario(scenario.id);
      expect(html).toBe(renderScenario(scenario.id));
      expect(html).toContain(`data-development-scenario="${scenario.id}"`);
      expect(html).toContain(`data-scenario-viewport="${scenario.viewport}"`);
      expect(html).toContain(`data-theme="${scenario.theme}"`);
      expect(html).toContain("inert");
      expect(html).not.toMatch(/\son(?:click|change|submit)=/iu);
      expect(scenario.limitation.length).toBeGreaterThan(20);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(() => blockedScenarioAction()).toThrow("actions are disabled");
    expect(() => renderScenario("unknown")).toThrow("Unknown development scenario");
  });

  it("uses current product presentation as positive controls", () => {
    expect(renderScenario("ready-game")).toContain("Play");
    expect(renderScenario("filtered-empty-library")).toContain(
      "No installed ports match your search and filters",
    );
    expect(renderScenario("unavailable-library")).toContain(
      "Library information could not be loaded",
    );
    const partialSuccess = renderScenario("partial-success");
    expect(partialSuccess).toContain("The change was saved");
    expect(partialSuccess).toContain("The change was committed");
    const cancellation = renderScenario("cancelled-operation");
    expect(cancellation).toContain("Operation cancelled");
    expect(cancellation).toContain("No files were changed");
    expect(renderScenario("missing-source")).toContain("game files");
    expect(renderScenario("missing-tool")).toContain("Not found");
    expect(renderScenario("staged-update")).toContain("Activate staged");
    expect(renderScenario("interrupted-operation")).toContain("Backup recovery required");
    expect(renderScenario("refresh-failure")).toContain("Showing the last loaded information");
    expect(renderScenario("unavailable-provider")).toContain("Artwork is unavailable");
    expect(renderScenario("library-reference-long-title")).toContain(
      "The Unreasonably Long Scenario Game Title",
    );
    const gameDetails = renderScenario("game-details-reference-narrow");
    expect(gameDetails).toContain("Play now");
    expect(gameDetails).toContain('data-slot="button"');
    expect(gameDetails).toContain('data-variant="primary"');
    expect(gameDetails).toContain('data-variant="ghost"');
    expect(gameDetails).toContain('data-variant="outline"');
    expect(renderScenario("installation-review-reference")).toContain("INSTALL PLAN");
    expect(renderScenario("installation-review-reference")).toContain("Install · 64.0 MiB");
    expect(renderScenario("installation-review-reference")).toContain("Not installed");
    expect(renderScenario("installation-review-reference")).toContain("2 ports");
  });
});

describe("development browser entry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    document.body.innerHTML = "";
    document.body.classList.remove("scenario-embed");
    window.history.replaceState(null, "", "/");
  });

  it("refuses production execution before loading scenarios", async () => {
    vi.resetModules();
    vi.stubEnv("DEV", false);
    await expect(import("./entry")).rejects.toThrow("ordinary development browser");
  });

  it("refuses an actual native bridge even in development mode", async () => {
    vi.resetModules();
    vi.stubEnv("DEV", true);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    await expect(import("./entry")).rejects.toThrow("ordinary development browser");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("switches static previews without hydrating their controls", async () => {
    vi.resetModules();
    vi.stubEnv("DEV", true);
    document.body.innerHTML =
      '<select id="scenario"></select><p id="scenario-limitation"></p><main id="scenario-preview"></main>';
    await import("./entry");
    const select = document.querySelector<HTMLSelectElement>("select")!;
    const preview = document.querySelector<HTMLElement>("main")!;
    expect(select.options).toHaveLength(scenarios.length);
    expect(preview.inert).toBe(true);
    select.value = "staged-update";
    select.dispatchEvent(new Event("change"));
    expect(preview.innerHTML).toContain("Activate staged");
    for (const button of preview.querySelectorAll("button")) button.click();
    expect(invoke).not.toHaveBeenCalled();
    expect(document.querySelector("#scenario-limitation")!.textContent).toContain(
      "Not interaction",
    );
    expect(new URL(window.location.href).searchParams.get("scenario")).toBe("staged-update");
  });

  it("opens an exact stable scenario from the handoff URL", async () => {
    vi.resetModules();
    vi.stubEnv("DEV", true);
    window.history.replaceState(null, "", "/scenarios.html?scenario=installation-review-reference");
    document.body.innerHTML =
      '<select id="scenario"></select><p id="scenario-limitation"></p><main id="scenario-preview"></main>';

    await import("./entry");

    expect(document.querySelector<HTMLSelectElement>("select")!.value).toBe(
      "installation-review-reference",
    );
    const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
    const frameUrl = new URL(frame.src);
    expect(frame.title).toContain("narrow reference viewport");
    expect(frameUrl.searchParams.get("scenario")).toBe("installation-review-reference");
    expect(frameUrl.searchParams.get("embed")).toBe("1");
    expect(window.location.search).toBe("?scenario=installation-review-reference");
  });

  it("renders the component directly inside the narrow browsing context", async () => {
    vi.resetModules();
    vi.stubEnv("DEV", true);
    window.history.replaceState(
      null,
      "",
      "/scenarios.html?scenario=installation-review-reference&embed=1",
    );
    document.body.innerHTML =
      '<header class="scenario-controls"><select id="scenario"></select><p id="scenario-limitation"></p></header><main id="scenario-preview"></main>';

    await import("./entry");

    expect(document.body.classList.contains("scenario-embed")).toBe(true);
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector<HTMLElement>("main")!.innerHTML).toContain("INSTALL PLAN");
  });
});
