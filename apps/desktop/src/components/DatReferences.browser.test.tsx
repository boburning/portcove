import { controlledAct as act } from "../../test/controlled-react-act";
import { captureParityState } from "../../test/parity-capture";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "../styles/index.css";
import type { DatReferenceStatus, SourceInspectionReport } from "../types";
import { failureReport, sourceInspectionIdentityFixture } from "../test-fixtures";
import { DatReferenceSettings } from "./DatReferences";
import { SourceIdentityPanel } from "./SourceIdentity";

const ready: DatReferenceStatus = {
  id: "0123456789abcdef",
  path: "C:/DATs/Nintendo - Nintendo 64.dat",
  name: "Nintendo - Nintendo 64",
  version: "20261113",
  entry_count: 2,
  file_count: 2,
  state: "ready",
  message: "Ready to name selected original game files.",
};

describe("DAT files", () => {
  let root: RenderResult;
  let host: HTMLDivElement;
  beforeEach(async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = await renderComponent(null, { container: host });
  });
  afterEach(async () => {
    await cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("adds, lists and removes DAT files through the supplied Core actions", async () => {
    let saved: DatReferenceStatus[] = [];
    const add = vi.fn(async (path: string) => {
      saved = [{ ...ready, path }];
      return saved[0]!;
    });
    const remove = vi.fn(async () => {
      saved = [];
    });
    await act(async () =>
      root.rerender(
        <DatReferenceSettings
          load={async () => saved}
          add={add}
          remove={remove}
          pick={async () => ready.path}
        />,
      ),
    );
    expect(host.textContent).toContain("No DAT files added.");
    expect(host.textContent).toContain("DAT files don’t change which files a game accepts.");

    const addButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Add DAT file",
    )!;
    await act(async () => addButton.click());
    expect(add).toHaveBeenCalledWith(ready.path);
    expect(host.textContent).toContain("Nintendo - Nintendo 64 (20261113)");
    expect(host.textContent).toContain("Ready · 2 entries");

    const removeButton = host.querySelector<HTMLButtonElement>(
      "[aria-label='Remove DAT file Nintendo - Nintendo 64 (20261113)']",
    )!;
    removeButton.focus();
    await act(async () => removeButton.click());
    expect(remove).toHaveBeenCalledWith(ready.id);
    expect(host.textContent).toContain("No DAT files added.");
    expect(document.activeElement).toBe(addButton);
  });

  it("holds the controls while the file picker is open", async () => {
    let choose!: (path: string | null) => void;
    const pick = () => new Promise<string | null>((resolve) => (choose = resolve));
    const add = vi.fn();
    await act(async () =>
      root.rerender(<DatReferenceSettings load={async () => []} add={add} pick={pick} />),
    );
    const addButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Add DAT file",
    )!;
    addButton.focus();
    await act(async () => addButton.click());
    expect(addButton.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(addButton);
    await act(async () => choose(null));
    expect(addButton.getAttribute("aria-disabled")).not.toBe("true");
    expect(document.activeElement).toBe(addButton);
    expect(add).not.toHaveBeenCalled();
  });

  it("offers a supported DAT format after refusal and retains the exact parser detail", async () => {
    const reason = "this DAT file can’t be used: it isn’t a complete Logiqx datafile";
    const failure = failureReport();
    failure.presentation.technical_message = reason;
    failure.presentation.technical_context = { dat_problem: "logiqx_format" };
    let saved: DatReferenceStatus[] = [];
    const add = vi
      .fn(async (path: string) => {
        const reference = { ...ready, path };
        saved = [reference];
        return reference;
      })
      .mockRejectedValueOnce(failure);
    const pick = vi.fn(async () => ready.path).mockResolvedValueOnce("C:/DATs/incomplete.dat");
    await act(async () =>
      root.rerender(<DatReferenceSettings load={async () => saved} add={add} pick={pick} />),
    );
    const addButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Add DAT file",
    )!;
    await act(async () => addButton.click());
    const alert = host.querySelector("[role='alert']");
    expect(alert?.textContent).toBe(
      "DAT file wasn’t added. Choose a complete Logiqx XML DAT file and add it again.",
    );
    expect(host.textContent).not.toContain(failure.presentation.summary);
    expect(host.textContent).toContain("No DAT files added.");
    const disclosure = host.querySelector("details");
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toBe("View technical details");
    const viewport = { width: innerWidth, height: innerHeight };
    const theme = document.documentElement.dataset.theme;
    try {
      document.documentElement.dataset.theme = "light";
      await page.viewport(960, 640);
      await captureParityState("dat-refused-logiqx-format");
      document.documentElement.dataset.theme = "dark";
      await page.viewport(430, 780);
      disclosure?.querySelector("summary")?.click();
      expect(disclosure?.open).toBe(true);
      expect(disclosure?.querySelector("pre")?.textContent).toContain(reason);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      await captureParityState("dat-refused-logiqx-format-details");
    } finally {
      if (theme) document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
      await page.viewport(viewport.width, viewport.height);
    }
    await act(async () => addButton.click());
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(2, ready.path);
    expect(host.querySelector("[role='alert']")).toBeNull();
    expect(host.textContent).toContain("Nintendo - Nintendo 64 (20261113)");
  });

  it("keeps non-format DAT failures distinct from the Logiqx replacement instruction", async () => {
    const failure = failureReport();
    failure.presentation.technical_message =
      "this DAT file can’t be used: it is larger than 64 MiB";
    await act(async () =>
      root.rerender(
        <DatReferenceSettings
          load={async () => []}
          add={vi.fn<() => Promise<DatReferenceStatus>>().mockRejectedValue(failure)}
          pick={async () => ready.path}
        />,
      ),
    );
    const addButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Add DAT file",
    )!;
    await act(async () => addButton.click());
    const text = host.querySelector("[role='alert']")?.textContent;
    expect(text).toContain(failure.presentation.technical_message);
    expect(text).not.toContain("Choose a complete Logiqx XML DAT file");
  });

  it("refreshes a failed inventory without picking a file and returns focus to Add", async () => {
    let available = false;
    const load = vi.fn(async () => {
      if (!available) throw new Error("Saved DAT list is temporarily unavailable.");
      return [ready];
    });
    const pick = vi.fn();
    await act(async () => root.rerender(<DatReferenceSettings load={load} pick={pick} />));
    expect(host.querySelector("[role='alert']")?.textContent).toContain(
      "Portcove couldn’t read your saved DAT files.",
    );
    const refresh = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh DAT files",
    )!;
    const addButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Add DAT file",
    )!;
    refresh.focus();
    available = true;
    await act(async () => refresh.click());
    expect(host.querySelector("[role='alert']")).toBeNull();
    expect(host.textContent).toContain("Ready · 2 entries");
    expect(document.activeElement).toBe(addButton);
    expect(pick).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged removal out of the list if refreshing fails", async () => {
    const remaining = { ...ready, id: "fedcba9876543210", name: "Another DAT file" };
    let removed = false;
    const load = async () => {
      if (removed) throw new Error("Saved DAT list is temporarily unavailable.");
      return [ready, remaining];
    };
    const remove = vi.fn(async () => {
      removed = true;
    });
    await act(async () => root.rerender(<DatReferenceSettings load={load} remove={remove} />));
    const removeButton = host.querySelector<HTMLButtonElement>(
      "[aria-label='Remove DAT file Nintendo - Nintendo 64 (20261113)']",
    )!;
    removeButton.focus();
    await act(async () => removeButton.click());
    expect(remove).toHaveBeenCalledExactlyOnceWith(ready.id);
    expect(removeButton.isConnected).toBe(false);
    expect(host.textContent).toContain("Another DAT file");
    expect(host.textContent).toContain("Refresh DAT files");
    expect(document.activeElement?.textContent).toBe("Add DAT file");
  });

  it("shows why a saved DAT file is not used", async () => {
    await act(async () =>
      root.rerender(
        <DatReferenceSettings
          load={async () => [
            {
              ...ready,
              state: "changed",
              message:
                "This DAT file changed after you added it. Add it again to use the new version.",
            },
          ]}
        />,
      ),
    );
    expect(host.textContent).toContain("Changed · 2 entries");
    expect(host.textContent).toContain("Add it again to use the new version.");
  });

  it("shows the informational DAT match beside the catalog result", async () => {
    const report: SourceInspectionReport = {
      ...sourceInspectionIdentityFixture(),
      dump_identification: {
        state_code: "identified",
        summary: "Matches “Example (Europe)” in Nintendo - Nintendo 64.",
        limitation:
          "DAT files only name the selected original game files. They don’t change which files this game accepts.",
        checked_reference_count: 1,
        match_count: 2,
        matches: [
          {
            reference_id: ready.id,
            reference_name: ready.name,
            entry_name: "Example (Europe)",
            complete: true,
            matched_files: [
              { file_name: "Example (Europe).z64", algorithm: "sha1", scope: "original-file" },
            ],
            entry_file_count: 1,
          },
          {
            reference_id: ready.id,
            reference_name: ready.name,
            entry_name: "Example (Europe) (Rev 1)",
            complete: false,
            matched_files: [
              {
                file_name: "Example (Europe) (Rev 1).z64",
                algorithm: "sha1",
                scope: "original-file",
              },
            ],
            entry_file_count: 2,
          },
        ],
        unavailable_references: [],
      },
    };
    await act(async () => root.rerender(<SourceIdentityPanel report={report} />));
    const note = host.querySelector("[aria-label='DAT file match']")!;
    expect(note.textContent).toContain("Matches “Example (Europe)” in Nintendo - Nintendo 64.");
    expect(note.textContent).toContain(
      "Partly matches “Example (Europe) (Rev 1)” in Nintendo - Nintendo 64",
    );
    expect(note.textContent).toContain("They don’t change which files this game accepts.");
  });
});
