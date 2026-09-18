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
    expect(renderScenario("missing-source")).toContain("game files");
    expect(renderScenario("missing-tool")).toContain("Not found");
    expect(renderScenario("staged-update")).toContain("Activate staged");
    expect(renderScenario("interrupted-operation")).toContain("Backup recovery required");
    expect(renderScenario("refresh-failure")).toContain("Showing the last loaded information");
    expect(renderScenario("unavailable-provider")).toContain("Artwork is unavailable");
  });
});

describe("development browser entry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    document.body.innerHTML = "";
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
  });
});
