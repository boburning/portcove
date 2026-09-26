// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { focusSettingsTarget } from "./focus-settings-target";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("focuses the matching source action, requirement, or safe heading", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const section = document.createElement("section");
  section.dataset.settingsGroup = "game-files";
  section.innerHTML = `
    <h2 id="settings-game-files-heading" tabindex="-1">Game Files</h2>
    <button data-settings-control="discover-sources">Choose game files</button>
    <div class="source-requirement" data-source-profile="needed" tabindex="-1"><button>Add source</button></div>
    <div class="source-health-row" data-source-profile="other" tabindex="-1"><button data-settings-control="relink-source">Relink other</button></div>
    <div class="source-health-row" data-source-profile="owned" tabindex="-1"><button data-settings-control="relink-source">Relink owned</button><button>Remove owned</button></div>`;
  document.body.append(section);

  focusSettingsTarget("source-profile", "owned");
  expect(document.activeElement?.textContent).toBe("Relink owned");
  focusSettingsTarget("source-profile", "needed");
  expect(document.activeElement?.textContent).toBe("Add source");
  focusSettingsTarget("source-profile", "missing");
  expect(document.activeElement?.id).toBe("settings-game-files-heading");
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  focusSettingsTarget("discover-sources");
  expect(document.activeElement?.textContent).toBe("Choose game files");
  expect(section.querySelector("h2")?.tabIndex).toBe(-1);

  section.querySelector<HTMLButtonElement>('[data-source-profile="owned"] button')!.disabled = true;
  focusSettingsTarget("source-profile", "owned");
  expect(document.activeElement?.getAttribute("data-source-profile")).toBe("owned");
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
});

it("focuses Library & Storage when the library volume needs space", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const section = document.createElement("section");
  section.dataset.settingsGroup = "library-storage";
  section.innerHTML =
    '<h2 id="settings-library-storage-heading" tabindex="-1">Library & Storage</h2>';
  document.body.append(section);
  focusSettingsTarget("library-storage");
  expect(document.activeElement?.id).toBe("settings-library-storage-heading");
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
});
