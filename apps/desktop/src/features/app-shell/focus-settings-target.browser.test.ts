import { afterEach, expect, it, vi } from "vite-plus/test";
import { focusSettingsTarget, settingsCategoryForTarget } from "./focus-settings-target";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("separates application updates from custom catalog recovery", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `
    <section data-settings-group="updates"><h2 id="settings-updates-heading" tabindex="-1">Updates</h2></section>
    <section data-settings-group="advanced"><h2 id="settings-advanced-heading" tabindex="-1">Advanced</h2>
      <button data-settings-control="catalog-updates">Check custom catalog</button></section>`;
  expect(settingsCategoryForTarget("application-updates")).toBe("updates");
  focusSettingsTarget("application-updates");
  expect(document.activeElement?.id).toBe("settings-updates-heading");
  expect(settingsCategoryForTarget("catalog-updates")).toBe("advanced");
  focusSettingsTarget("catalog-updates");
  expect(document.activeElement?.textContent).toBe("Check custom catalog");
});

it("focuses the matching source action, requirement, or safe heading", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const section = document.createElement("section");
  section.dataset.settingsGroup = "game-files";
  section.innerHTML = `
    <h2 id="settings-game-files-heading" tabindex="-1">Game files</h2>
    <button data-settings-control="add-game-file-root">Add folder</button>
    <button data-settings-control="discover-sources">Find required files</button>
    <div class="source-requirement" data-source-profile="needed" tabindex="-1"><button>Add game files</button></div>
    <div class="source-health-row" data-source-profile="other" tabindex="-1"><button data-settings-control="relink-source">Relink other</button></div>
    <div class="source-health-row" data-source-profile="owned" tabindex="-1"><button data-settings-control="relink-source">Relink owned</button><button>Remove owned</button></div>`;
  document.body.append(section);

  focusSettingsTarget("source-profile", "owned");
  expect(document.activeElement?.textContent).toBe("Relink owned");
  focusSettingsTarget("source-profile", "needed");
  expect(document.activeElement?.textContent).toBe("Add game files");
  focusSettingsTarget("source-profile", "missing");
  expect(document.activeElement?.id).toBe("settings-game-files-heading");
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  focusSettingsTarget("discover-sources");
  expect(document.activeElement?.textContent).toBe("Find required files");
  focusSettingsTarget("add-game-file-root");
  expect(document.activeElement?.textContent).toBe("Add folder");
  expect(section.querySelector("h2")?.tabIndex).toBe(-1);

  section.querySelector<HTMLButtonElement>('[data-source-profile="owned"] button')!.disabled = true;
  focusSettingsTarget("source-profile", "owned");
  expect(document.activeElement?.getAttribute("data-source-profile")).toBe("owned");
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
});

it("focuses Library and storage when the library volume needs space", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const section = document.createElement("section");
  section.dataset.settingsGroup = "library-storage";
  section.innerHTML =
    '<h2 id="settings-library-storage-heading" tabindex="-1">Library and storage</h2>';
  document.body.append(section);
  focusSettingsTarget("library-storage");
  expect(document.activeElement?.id).toBe("settings-library-storage-heading");
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
});

it("focuses Add folder after saved folders load only while focus remains on Game files", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const section = document.createElement("section");
  section.dataset.settingsGroup = "game-files";
  section.innerHTML = `<h2 id="settings-game-files-heading" tabindex="-1">Game files</h2>
    <button data-settings-control="add-game-file-root" disabled>Add folder</button>
    <button>Another action</button>`;
  document.body.append(section);
  const add = section.querySelector<HTMLButtonElement>(
    '[data-settings-control="add-game-file-root"]',
  )!;
  focusSettingsTarget("add-game-file-root");
  expect(document.activeElement?.id).toBe("settings-game-files-heading");
  add.disabled = false;
  await vi.waitFor(() => expect(document.activeElement).toBe(add));

  add.disabled = true;
  focusSettingsTarget("add-game-file-root");
  section.querySelectorAll("button")[1]?.focus();
  add.disabled = false;
  await Promise.resolve();
  expect(document.activeElement?.textContent).toBe("Another action");
});

it("routes History diagnostics to the support-bundle control with a safe disabled fallback", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `<section data-settings-group="advanced"><h2 id="settings-advanced-heading" tabindex="-1">Advanced</h2><button data-settings-control="diagnostics">Create support bundle</button></section>`;
  expect(settingsCategoryForTarget("diagnostics")).toBe("advanced");
  focusSettingsTarget("diagnostics");
  expect(document.activeElement?.textContent).toBe("Create support bundle");
  document.querySelector("button")!.disabled = true;
  focusSettingsTarget("diagnostics");
  expect(document.activeElement?.id).toBe("settings-advanced-heading");
});
