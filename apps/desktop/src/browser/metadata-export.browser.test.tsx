import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { pickMetadataExportPath } from "../file-picker";
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
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Library and storage", exact: true })
    .click();
  await page.getByText("Prepare a recovery copy", { exact: true }).click();
}

it("announces a declined metadata picker as cancelled without exporting or showing a receipt", async () => {
  vi.mocked(pickMetadataExportPath).mockResolvedValue(null);
  const exported = vi.spyOn(desktopApi, "exportLibraryMetadata");
  await openExport();
  await page.getByRole("button", { name: "Export metadata", exact: true }).click();
  await expect
    .poll(() => page.getByRole("status", { name: "Task updates" }).element().textContent)
    .toContain("export library metadata · fixture/library: cancelled.");
  expect(exported).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Metadata exported to");
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
  await page.getByRole("button", { name: "Export metadata", exact: true }).click();
  await expect
    .poll(() => page.getByRole("status", { name: "Task updates" }).element().textContent)
    .toContain("export library metadata · fixture/library: finished.");
  expect(exported).toHaveBeenCalledExactlyOnceWith("C:\\owned\\metadata.json");
  await expect
    .poll(() => document.body.textContent)
    .toContain("Metadata exported to C:\\owned\\metadata.json");
});

for (const failure of ["picker", "export"] as const) {
  it(`retains an actual ${failure} failure rather than reporting cancellation`, async () => {
    vi.mocked(pickMetadataExportPath).mockResolvedValue("C:\\owned\\metadata.json");
    const exported = vi.spyOn(desktopApi, "exportLibraryMetadata");
    if (failure === "picker")
      vi.mocked(pickMetadataExportPath).mockRejectedValue(new Error("Picker unavailable"));
    else exported.mockRejectedValue(new Error("Export unavailable"));
    await openExport();
    await page.getByRole("button", { name: "Export metadata", exact: true }).click();
    await expect
      .poll(() => page.getByRole("alert").element().textContent)
      .toContain(failure === "picker" ? "Picker unavailable" : "Export unavailable");
    expect(document.querySelector("[data-invocation-announcements]")?.textContent).not.toContain(
      "cancelled",
    );
    expect(document.body.textContent).not.toContain("Metadata exported to");
    expect(exported).toHaveBeenCalledTimes(failure === "picker" ? 0 : 1);
  });
}
