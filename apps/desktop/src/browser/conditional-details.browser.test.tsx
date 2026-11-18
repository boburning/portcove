import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import type {} from "vite-plus/test/browser-playwright";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { THEME_STORAGE_KEY } from "../theme";
import { browserFixture } from "../../test/browser-fixture";
import { controlledAct as act } from "../../test/controlled-react-act";
import {
  conditionalDetailsFixture,
  type ConditionalDetailsConfiguration,
  type OutputMode,
} from "../../test/conditional-details-fixture";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../../test/capture-target";
import { observeVisibleTarget } from "../../scripts/browser-readiness.mts";
import { captureParityState } from "../../test/parity-capture";
import "../styles/index.css";

const action = { timeout: 15_000 };
let owner: ReturnType<typeof browserFixture>;
let fixture: ReturnType<typeof conditionalDetailsFixture> | undefined;
let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let pageErrors: string[];
let captures: string[];
let theme: "dark" | "light";
let row: string;
beforeEach(() => {
  owner = browserFixture({
    viewport: true,
    storage: true,
    attributes: ["data-theme", "lang", "dir"],
  });
  pageErrors = [];
  captures = [];
  const onError = (event: ErrorEvent) => {
    pageErrors.push(event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    pageErrors.push(String(event.reason));
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  owner.defer(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });
});
afterEach(async () => {
  // Join the only controlled operation before unmounting/resetting the API spies.
  // browserFixture runs every cleanup even if an earlier one refuses.
  owner.defer(() => {
    vi.restoreAllMocks();
  });
  owner.defer(() => {
    transport?.dispose();
    transport = undefined;
  });
  owner.defer(() => {
    document.getElementById("root")?.remove();
  });
  owner.defer(() => cleanup());
  owner.defer(async () => {
    await act(async () => {
      await fixture?.dispose();
    });
    fixture = undefined;
  });
  await owner.dispose();
});

async function mount(
  configuration: ConditionalDetailsConfiguration,
  color: "dark" | "light",
  width: number,
  height: number,
) {
  theme = color;
  row = `${configuration}-${color}-${width}`;
  await page.viewport(width, height);
  const media = cdp();
  owner.defer(async () => {
    await media.send("Emulation.setEmulatedMedia", { features: [] });
  });
  await media.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: color },
    ],
  });
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  localStorage.clear();
  localStorage.setItem(THEME_STORAGE_KEY, color);
  fixture = conditionalDetailsFixture(configuration);
  const current = fixture;
  const h = current.handlers;
  transport = installInteractiveTransport("details", (message) => {
    throw new Error(message);
  });
  vi.spyOn(desktopApi, "workspaceSnapshot").mockImplementation(async (generation, digest) =>
    h.get_workspace_snapshot({ generation, knownCatalogDigest: digest ?? null }),
  );
  vi.spyOn(desktopApi, "modSetups").mockImplementation(async (portId, generation) =>
    h.get_mod_setups({ portId, generation }),
  );
  vi.spyOn(desktopApi, "runtimePrerequisites").mockImplementation(
    async (portId, installId, generation) =>
      h.get_runtime_prerequisites({ portId, installId, generation }),
  );
  vi.spyOn(desktopApi, "portCapabilities").mockImplementation(async (portId, generation) =>
    h.get_port_capabilities({ portId, generation }),
  );
  vi.spyOn(desktopApi, "artwork").mockImplementation(async (portId, slot, generation) =>
    h.get_artwork({ portId, slot, generation }),
  );
  vi.spyOn(desktopApi, "backups").mockImplementation(async (portId) => h.get_backups({ portId }));
  vi.spyOn(desktopApi, "outputLocation").mockImplementation(async (portId, generation) =>
    h.get_output_location({ portId, generation }),
  );
  vi.spyOn(desktopApi, "outputRelocationStatus").mockImplementation(async (portId, generation) =>
    h.get_output_relocation_status({ portId, generation }),
  );
  vi.spyOn(desktopApi, "previewOutputLocation").mockImplementation(
    async (portId, path, generation) => h.preview_output_location({ portId, path, generation }),
  );
  vi.spyOn(desktopApi, "planOutputRelocation").mockImplementation(
    async (portId, path, generation) => h.plan_output_relocation({ portId, path, generation }),
  );
  vi.spyOn(desktopApi, "setOutputLocation").mockImplementation(
    (portId, path, expectedPreview, generation) =>
      h.set_output_location({ portId, path, expectedPreview, generation }),
  );
  vi.spyOn(desktopApi, "resetOutputLocation").mockImplementation(
    (portId, expectedPreview, generation) =>
      h.reset_output_location({ portId, expectedPreview, generation }),
  );
  for (const name of [
    "launch",
    "install",
    "prepare",
    "changeToManagedRuntime",
    "relocateOutput",
    "openExternalUrl",
    "openUserData",
    "openManualSetupFolder",
  ] as const) {
    vi.spyOn(desktopApi, name).mockImplementation(() => current.forbidden(name));
  }
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const localization = initializeLocalization(),
    language = localization.language;
  owner.defer(() => localization.changeLanguage(language).then(() => {}));
  await localization.changeLanguage("en");
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect
    .element(page.getByRole("textbox", { name: "Search your library", exact: true }), {
      timeout: 60_000,
    })
    .toBeVisible();
  await expect.poll(() => document.documentElement.dataset.theme, { timeout: 60_000 }).toBe(color);
  const trigger = document.querySelector<HTMLButtonElement>(
    `[data-detail-game-id="${current.port.id}"]`,
  );
  expect(trigger).toBeInstanceOf(HTMLButtonElement);
  await page.elementLocator(trigger!).click(action);
  await expect.poll(() => !!document.querySelector("[data-detail-workspace]"), action).toBe(true);
  return current;
}

function selectorFor(element: Element) {
  const path: string[] = [];
  for (
    let node: Element | null = element;
    node && node !== document.documentElement;
    node = node.parentElement
  ) {
    path.unshift(
      `${node.tagName.toLowerCase()}:nth-child(${[...node.parentElement!.children].indexOf(node) + 1})`,
    );
  }
  return "html > " + path.join(" > ");
}
async function capture(name: string, target: Element) {
  const selector = selectorFor(target);
  const ready = await prepareCaptureTarget({
    target: selector,
    label: `${row}:${name}`,
    scroll: () => target.scrollIntoView({ block: "center" }),
    observe: () => observeVisibleTarget(selector, "visual"),
    timeoutMs: 5000,
  });
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  for (const main of document.querySelectorAll("main"))
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  await captureParityState(`conditional-${row}-${name}`);
  requireUnchangedCaptureTarget(ready.observation, observeVisibleTarget(selector, "visual"));
  captures.push(name);
}
const button = (name: string) => page.getByRole("button", { name, exact: true });
const heading = () => document.querySelector<HTMLElement>("#output-location-review-title")!;
async function tab(name: string) {
  await page.getByRole("tab", { name, exact: true }).click(action);
}
async function cancelOutput() {
  await button("Cancel review").click(action);
  await expect
    .poll(
      () =>
        !!document.querySelector("#output-location-review-title, #output-relocation-review-title"),
      action,
    )
    .toBe(false);
}
function inside(element: Element) {
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(innerWidth + 1);
  expect(box.bottom).toBeLessThanOrEqual(innerHeight + 1);
}
async function actions(name: string, primary: string) {
  const cancel = button("Cancel review").element();
  await capture(name, cancel);
  inside(cancel);
  inside(button(primary).element());
}
function technicalSummaryGeometry() {
  const title = page.getByText("Technical details", { exact: true }).element();
  const summary = title.closest("summary");
  const column = title.parentElement;
  const icon = summary?.querySelector("svg");
  if (!summary || !column || !icon)
    throw new Error("Technical details requires its actual summary, text column and icon");
  const titleRange = document.createRange();
  titleRange.selectNodeContents(title);
  const firstLine = titleRange.getClientRects().item(0);
  if (!firstLine) throw new Error("Technical details title has no rendered first line");
  const textRange = document.createRange();
  textRange.selectNodeContents(column);
  const bounds = summary.getBoundingClientRect();
  const iconBounds = icon.getBoundingClientRect();
  const style = getComputedStyle(summary);
  const trailingEdge =
    style.direction === "rtl"
      ? bounds.left + Number.parseFloat(style.paddingLeft)
      : bounds.right - Number.parseFloat(style.paddingRight);
  return {
    summary,
    bounds,
    iconBounds,
    firstLine,
    trailingEdge,
    iconTrailingEdge: style.direction === "rtl" ? iconBounds.left : iconBounds.right,
    textColumn: column.getBoundingClientRect(),
    textFragments: [...textRange.getClientRects()],
  };
}
function expectTechnicalSummaryFits() {
  const {
    summary,
    bounds,
    iconBounds,
    firstLine,
    trailingEdge,
    iconTrailingEdge,
    textColumn,
    textFragments,
  } = technicalSummaryGeometry();
  expect(iconBounds.width).toBeGreaterThan(0);
  expect(iconBounds.height).toBeGreaterThan(0);
  expect(iconBounds.left).toBeGreaterThanOrEqual(bounds.left);
  expect(iconBounds.right).toBeLessThanOrEqual(bounds.right);
  expect(iconBounds.top).toBeGreaterThanOrEqual(bounds.top);
  expect(iconBounds.bottom).toBeLessThanOrEqual(bounds.bottom);
  expect(Number.isFinite(trailingEdge)).toBe(true);
  expect(Math.abs(iconTrailingEdge - trailingEdge)).toBeLessThanOrEqual(1);
  expect(
    Math.abs((iconBounds.top + iconBounds.bottom) / 2 - (firstLine.top + firstLine.bottom) / 2),
  ).toBeLessThanOrEqual(2);
  expect(textFragments.length).toBeGreaterThan(0);
  for (const fragment of textFragments) {
    expect(fragment.left).toBeGreaterThanOrEqual(textColumn.left - 1);
    expect(fragment.right).toBeLessThanOrEqual(textColumn.right + 1);
  }
  expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
}
async function openOutput(color: "dark" | "light", width: number, height: number) {
  const current = await mount("output", color, width, height);
  expect(
    document.querySelectorAll(
      "[data-runtime-prerequisites], .detail-funding, [data-setup-warnings]",
    ),
  ).toHaveLength(0);
  await tab("Manage");
  await page.getByText("Folder for a future install", { exact: true }).click(action);
  const input = page.getByRole("textbox", { name: "Folder for future installs", exact: true });
  await capture("future-folder-expanded", input.element());
  expectTechnicalSummaryFits();
  const path = "F:/Synthetic review only/" + "long-folder-name/".repeat(12);
  await input.fill(path, action);
  await button("Review future folder").click(action);
  await expect.poll(() => document.activeElement?.id, action).toBe("output-location-review-title");
  await expect.element(page.getByText(path, { exact: true })).toBeVisible();
  await capture("future-review-long-path", heading());
  await actions("future-review-actions", "Use this folder for future installs");
  return current;
}

it("retains the quiet carried outcome and update disclosure in actual App at dark 960x640", async () => {
  await mount("carried-small", "dark", 960, 640);
  await tab("Versions & updates");
  const record = page.getByText("Review the recorded file outcome", { exact: true });
  await expect.element(record).toBeVisible();
  expect(
    page
      .getByRole("heading", { name: "Files kept during the version switch", exact: true })
      .query(),
  ).toBeNull();
  await capture("small-collapsed-in-versions", record.element());
  const preferences = page.getByText("Future update preferences", { exact: true });
  const summary = preferences.element();
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  summary.focus();
  await expect.element(preferences).toHaveFocus();
  await capture("future-update-preferences-focused", summary);
  // These are the same actual summary/text/marker measurements as the frozen App2 row.
  const range = document.createRange();
  range.selectNodeContents(summary);
  const marker = getComputedStyle(summary, "::before");
  expect([...range.getClientRects()].every((box) => Number.isFinite(box.x) && box.width > 0)).toBe(
    true,
  );
  expect(Number.parseFloat(marker.width)).toBeGreaterThan(0);
  expect(Number.isFinite(Number.parseFloat(marker.top))).toBe(true);
  expect(Number.isFinite(Number.parseFloat(marker.left))).toBe(true);
  expect(Number.parseFloat(getComputedStyle(summary).paddingBlockStart)).toBeGreaterThanOrEqual(0);
  await userEvent.keyboard("{Enter}");
  expect(details.open).toBe(true);
  await capture("future-update-preferences-expanded", summary);
  await userEvent.keyboard("{Enter}");
  expect(details.open).toBe(false);
  await expect.element(preferences).toHaveFocus();
  expect(captures).toEqual([
    "small-collapsed-in-versions",
    "future-update-preferences-focused",
    "future-update-preferences-expanded",
  ]);
  expect(fixture!.forbiddenCalls).toEqual([]);
  expect(pageErrors).toEqual([]);
}, 180_000);

it("keeps the exact future-folder review and all actions inside actual App at light 430x780", async () => {
  await openOutput("light", 430, 780);
  await expect
    .element(page.getByText("1 remains at its recorded location", { exact: true }))
    .toBeVisible();
  expect(
    page.getByText("1 remain at their recorded locations", { exact: true }).query(),
  ).toBeNull();
  inside(button("Review moving existing versions").element());
  await cancelOutput();
  expect(captures).toEqual([
    "future-folder-expanded",
    "future-review-long-path",
    "future-review-actions",
  ]);
  expect(fixture!.forbiddenCalls).toEqual([]);
  expect(pageErrors).toEqual([]);
}, 180_000);

it("retains separate relocation, suitability and refused apply in actual App at dark 960x640", async () => {
  const current = await openOutput("dark", 960, 640);
  await button("Review moving existing versions").click(action);
  await expect
    .element(page.getByRole("heading", { name: "Review moving existing versions", exact: true }))
    .toBeVisible();
  await capture(
    "recorded-versions-separate-review",
    document.querySelector("#output-relocation-review-title")!,
  );
  await actions("recorded-versions-review-actions", "Move existing versions");
  await cancelOutput();
  await button("Review library default").click(action);
  await capture("reset-to-default-review", heading());
  await cancelOutput();
  for (const mode of ["invalid", "full", "unknown"] satisfies OutputMode[]) {
    current.setOutputMode(mode);
    await button("Review future folder").click(action);
    await capture(`destination-${mode}`, heading());
    const apply = button("Use this folder for future installs");
    expect(apply.element().hasAttribute("disabled")).toBe(mode !== "unknown");
    await cancelOutput();
  }
  current.setOutputMode("safe");
  await button("Review future folder").click(action);
  await button("Use this folder for future installs").click(action);
  await expect.poll(current.pending, action).toEqual(["output-apply"]);
  await capture("apply-pending", heading());
  await act(async () => {
    current.releaseApply();
  });
  const refusal = page.getByText("Synthetic future-folder setting refused.", { exact: false });
  await expect.element(refusal).toBeVisible();
  await capture("apply-refused", refusal.element());
  expect(current.pending()).toEqual([]);
  expect(captures).toEqual([
    "future-folder-expanded",
    "future-review-long-path",
    "future-review-actions",
    "recorded-versions-separate-review",
    "recorded-versions-review-actions",
    "reset-to-default-review",
    "destination-invalid",
    "destination-full",
    "destination-unknown",
    "apply-pending",
    "apply-refused",
  ]);
  expect(current.forbiddenCalls).toEqual([]);
  expect(pageErrors).toEqual([]);
}, 360_000);
