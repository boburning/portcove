import axe from "axe-core";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { THEME_STORAGE_KEY } from "../theme";
import { browserFixture } from "../../test/browser-fixture";
import { auditAccessibility } from "../../test/accessibility";

let fixture: ReturnType<typeof browserFixture>;
beforeEach(() => {
  fixture = browserFixture({
    storage: true,
    attributes: ["data-theme", "lang", "dir"],
    viewport: true,
  });
  localStorage.clear();
  fixture.defer(() => {
    vi.restoreAllMocks();
  });
});
afterEach(async () => fixture.dispose());

async function mount(theme: "dark" | "light", width: number) {
  await page.viewport(width, 800);
  const transport = installInteractiveTransport("comparison", (message) => {
    throw new Error(message);
  });
  fixture.defer(() => transport.dispose());
  const localization = initializeLocalization(),
    language = localization.language;
  fixture.defer(() => localization.changeLanguage(language).then(() => {}));
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  fixture.defer(() => root.remove());
  fixture.defer(() => cleanup());
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect.poll(() => root.querySelectorAll(".collection-entry").length).toBe(12);
  await document.fonts.ready;
  await expect
    .poll(() => [...root.querySelectorAll("img")].every((image) => image.complete))
    .toBe(true);
  return root;
}

// Full-page rendering and axe scans need finite owner headroom on a cold browser;
// semantic action/assertion deadlines and cleanup remain unchanged.
it("audits the complete light desktop library and rows with all default axe rules", async (context) => {
  const root = await mount("light", 1280);
  await auditAccessibility(root, "library/light/1280/covers", context);
  await page.getByRole("button", { name: "Compact rows", exact: true }).click();
  expect(root.querySelectorAll(".collection-row")).toHaveLength(12);
  await auditAccessibility(root, "library/light/1280/rows", context);
}, 45_000);

it("audits narrow dark navigation while preserving focus containment and return", async (context) => {
  await mount("dark", 320);
  const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
  await navigation.click();
  const dialog = page.getByRole("dialog", { name: "Navigation", exact: true });
  await expect.element(dialog.getByRole("button", { name: /^Library/ })).toHaveFocus();
  await auditAccessibility(dialog.element(), "navigation-modal/dark/320", context);
  for (let index = 0; index < 10; index++) {
    await userEvent.keyboard("{Tab}");
    await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true);
  }
  await userEvent.keyboard("{Escape}");
  await expect.element(navigation).toHaveFocus();
  // A real shipped icon-only control must be seen by the broad scan when its name is lost.
  const button = navigation.element(),
    name = button.getAttribute("aria-label");
  expect(name).toBe("Open navigation");
  try {
    button.removeAttribute("aria-label");
    const broken = await axe.run(button);
    expect(broken.violations.some(({ id }) => id === "button-name")).toBe(true);
  } finally {
    button.setAttribute("aria-label", name!);
  }
  await auditAccessibility(button, "restored-navigation-control/dark/320", context);
}, 45_000);

it("audits the long-identity details state with all default rules", async (context) => {
  const root = await mount("dark", 320);
  await page.getByRole("button", { name: /^View details for The Very Long Voyage/ }).click();
  await expect.element(page.getByRole("heading", { name: /^The Very Long Voyage/ })).toHaveFocus();
  await auditAccessibility(root, "details/long-identity/dark/320", context);
}, 45_000);
