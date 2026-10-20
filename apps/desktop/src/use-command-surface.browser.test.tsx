import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { useCommandSurface } from "./use-command-surface";
import type { View } from "./view-model";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});
function SearchContext({ view, navigate }: { view: View; navigate: (view: View) => void }) {
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
      <input aria-label="Editing a value" />
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
