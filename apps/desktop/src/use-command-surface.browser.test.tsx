import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { ChoiceSelect } from "./components/ChoiceSelect";
import { useCommandSurface } from "./use-command-surface";
import type { View } from "./view-model";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});
function SearchContext({
  view,
  navigate,
  browseMods = false,
}: {
  view: View;
  navigate: (view: View) => void;
  browseMods?: boolean;
}) {
  useCommandSurface({
    view,
    installedCount: 0,
    busy: false,
    setView: navigate,
    setAdoptOpen: vi.fn(),
    setSelectedId: vi.fn(),
    checkAll: async () => {},
  });
  return (
    <>
      <button>Workspace</button>
      {(view === "library" || view === "catalog") && (
        <input id="port-search" aria-label="Current search" />
      )}
      {browseMods && (
        <search data-active-mod-search="">
          <input type="search" aria-label="Search mods" />
          <ChoiceSelect
            label="Sort"
            value="downloads"
            options={[{ value: "downloads", label: "Most downloaded" }]}
            onChange={vi.fn()}
          />
        </search>
      )}
      <input aria-label="Editing a value" />
      <div contentEditable suppressContentEditableWarning>
        <span data-editable-child>Editable content</span>
      </div>
    </>
  );
}
it.for(["library", "catalog"] as const)("searches %s without changing its route", async (view) => {
  const navigate = vi.fn();
  await render(<SearchContext view={view} navigate={navigate} />);
  await page.getByRole("button", { name: "Workspace" }).click();
  await userEvent.keyboard("{Control>}f{/Control}");
  await expect.element(page.getByRole("textbox", { name: "Current search" })).toHaveFocus();
  expect(navigate).not.toHaveBeenCalled();
});
it("focuses Browse mods search and respects an open sort popup", async () => {
  const navigate = vi.fn();
  await render(<SearchContext view="catalog" navigate={navigate} browseMods />);
  page.getByRole("button", { name: "Workspace" }).element().focus();
  await userEvent.keyboard("{Control>}f{/Control}");
  const search = page.getByRole("searchbox", { name: "Search mods" });
  await expect.element(search).toHaveFocus();

  page
    .getByRole("combobox", { name: /^Sort\b/ })
    .element()
    .focus();
  await userEvent.keyboard("{Enter}");
  const popup = page.getByRole("listbox");
  await expect.element(popup).toBeVisible();
  const surface = popup.element().closest("[data-portcove-focus-scope]");
  await expect.poll(() => surface?.contains(document.activeElement)).toBe(true);
  const focused = document.activeElement;
  await userEvent.keyboard("{Control>}f{/Control}");
  await expect.element(popup).toBeVisible();
  expect(document.activeElement).toBe(focused);
  expect(navigate).not.toHaveBeenCalled();
});
it("leaves nested editable and composing events untouched", async () => {
  const navigate = vi.fn();
  await render(<SearchContext view="library" navigate={navigate} />);
  const editable = document.querySelector<HTMLElement>("[contenteditable]")!;
  editable.focus();
  const nested = document.querySelector("[data-editable-child]")!;
  const command = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  nested.dispatchEvent(command);
  expect(command.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(editable);
  const composing = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  document.querySelector("button")!.dispatchEvent(composing);
  expect(composing.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
it("leaves slash, Settings and editable input alone", async () => {
  const navigate = vi.fn();
  await render(<SearchContext view="settings" navigate={navigate} />);
  const workspace = page.getByRole("button", { name: "Workspace" });
  await workspace.click();
  await userEvent.keyboard("/");
  await expect.element(workspace).toHaveFocus();
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(navigate).not.toHaveBeenCalled();
  const field = page.getByRole("textbox", { name: "Editing a value" });
  await field.fill("original");
  await userEvent.keyboard("{Control>}f{/Control}");
  await expect.element(field).toHaveFocus();
  await expect.element(field).toHaveValue("original");
});
