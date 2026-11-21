import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { pickMetadataExportPath } from "../file-picker";
import { failureReport } from "../test-fixtures";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";

vi.mock("../file-picker", { spy: true });
let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let root: HTMLDivElement | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await cleanup();
  root?.remove();
  transport?.dispose();
  root = undefined;
  transport = undefined;
  vi.restoreAllMocks();
});

async function openExport() {
  await page.viewport(1280, 800);
  transport = installInteractiveTransport("collection", (message) => {
    throw new Error(message);
  });
  initializeLocalization(["en"]);
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect
    .poll(() => document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize"))
    .toBe("12");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Library and storage", exact: true })
    .click();
  expect(
    page.getByText("Prepare a recovery copy", { exact: true }).element().closest("details")?.open,
  ).toBe(false);
}

const receipt = () => document.querySelector(".library-recovery [role=status]");

it("keeps recovery bundle actions available when the storage report fails", async () => {
  const doctor = vi.spyOn(desktopApi, "doctor").mockRejectedValue(new Error("Storage unavailable"));
  await openExport();
  await expect.poll(() => doctor.mock.calls.length).toBeGreaterThan(0);
  await expect
    .element(page.getByText("Storage capacity is unavailable for this location.", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Create recovery bundle", exact: true }))
    .toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Inspect or restore a bundle", exact: true }))
    .toBeEnabled();
});

it("announces a declined metadata picker as cancelled without exporting or showing a receipt", async () => {
  vi.mocked(pickMetadataExportPath).mockResolvedValue(null);
  const exported = vi.spyOn(desktopApi, "exportLibraryMetadata");
  await openExport();
  await page.getByRole("button", { name: "Export library information", exact: true }).click();
  await expect
    .poll(() => document.querySelector("[data-invocation-announcements]")?.textContent)
    .toContain("export library metadata · fixture/library: cancelled.");
  expect(exported).not.toHaveBeenCalled();
  expect(receipt()).toBeNull();
  expect(document.querySelector("[data-invocation-announcements]")?.textContent).not.toContain(
    "finished",
  );
});

it("exports the selected path and retains its successful metadata receipt", async () => {
  vi.mocked(pickMetadataExportPath).mockResolvedValue("C:\\owned\\metadata.json");
  const exported = vi.spyOn(desktopApi, "exportLibraryMetadata").mockResolvedValue({
    path: "C:\\owned\\metadata.json",
    sha256: "a".repeat(64),
    size: 803,
  });
  await openExport();
  await page.getByRole("button", { name: "Export library information", exact: true }).click();
  await expect
    .poll(() => document.querySelector("[data-invocation-announcements]")?.textContent)
    .toContain("export library metadata · fixture/library: finished.");
  expect(exported).toHaveBeenCalledExactlyOnceWith("C:\\owned\\metadata.json");
  await expect
    .poll(() => receipt()?.textContent)
    .toContain("Library information was last exported to C:\\owned\\metadata.json");
});

for (const failure of ["picker", "export"] as const) {
  it(`retains an actual ${failure} failure rather than reporting cancellation`, async () => {
    vi.mocked(pickMetadataExportPath).mockResolvedValue("C:\\owned\\metadata.json");
    const exported = vi.spyOn(desktopApi, "exportLibraryMetadata");
    if (failure === "picker")
      vi.mocked(pickMetadataExportPath).mockRejectedValue(new Error("Picker unavailable"));
    else exported.mockRejectedValue(new Error("Export unavailable"));
    await openExport();
    const action = page.getByRole("button", { name: "Export library information", exact: true });
    const detail = failure === "picker" ? "Picker unavailable" : "Export unavailable";
    await action.click();
    await expect.element(page.getByRole("alert")).toMatchTextContent(detail);
    const inline = page.getByText(`Library information export did not finish: ${detail}`, {
      exact: true,
    });
    await expect.element(inline).toBeVisible();
    expect(action.element().getAttribute("aria-describedby")).toBe(inline.element().id);
    await expect.element(action).toHaveFocus();
    expect(document.querySelector("[data-invocation-announcements]")?.textContent).not.toContain(
      "cancelled",
    );
    expect(receipt()).toBeNull();
    expect(exported).toHaveBeenCalledTimes(failure === "picker" ? 0 : 1);
  });
}

it("explains a refused existing destination and allows a new filename", async () => {
  const existing = "C:\\owned\\metadata.json";
  const fresh = "C:\\owned\\metadata-new.json";
  vi.mocked(pickMetadataExportPath).mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh);
  const failure = failureReport();
  const summary =
    "Portcove kept the existing file. Choose a new filename to export library information.";
  const exported = vi
    .spyOn(desktopApi, "exportLibraryMetadata")
    .mockRejectedValueOnce({
      ...failure,
      code: "state",
      presentation: {
        ...failure.presentation,
        presentation_key: "metadata_export_exists",
        summary,
        mutation_state: "no_changes",
      },
    })
    .mockResolvedValueOnce({ path: fresh, sha256: "a".repeat(64), size: 803 });
  await openExport();
  const action = page.getByRole("button", { name: "Export library information", exact: true });
  await expect
    .element(page.getByText(/Choose a new filename\. Portcove keeps existing files/))
    .toBeVisible();
  await action.click();
  await expect.element(page.getByRole("alert")).toMatchTextContent(summary);
  const inline = page.getByText(`Library information export did not finish: ${summary}`, {
    exact: true,
  });
  await expect.element(inline).toBeVisible();
  expect(receipt()).toBeNull();
  expect(exported).toHaveBeenCalledExactlyOnceWith(existing);
  await action.click();
  await expect
    .poll(() => receipt()?.textContent)
    .toContain(`Library information was last exported to ${fresh}`);
  await expect.element(inline).not.toBeInTheDocument();
  expect(exported.mock.calls).toEqual([[existing], [fresh]]);
});
