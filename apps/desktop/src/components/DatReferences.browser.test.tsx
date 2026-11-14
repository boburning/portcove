import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DatReferenceStatus, SourceInspectionReport } from "../types";
import { sourceInspectionIdentityFixture } from "../test-fixtures";
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
  message: "Ready to name selected game files.",
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

    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[aria-label='Remove DAT file Nintendo - Nintendo 64']")!
        .click(),
    );
    expect(remove).toHaveBeenCalledWith(ready.id);
    expect(host.textContent).toContain("No DAT files added.");
  });

  it("shows why a saved DAT file is not used", async () => {
    await act(async () =>
      root.rerender(
        <DatReferenceSettings
          load={async () => [
            {
              ...ready,
              state: "changed",
              message: "This DAT file changed after you added it. Add it again to use the new version.",
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
          "DAT files only name the selected files. They don’t change which files this game accepts.",
        checked_reference_count: 1,
        match_count: 2,
        matches: [
          {
            reference_id: ready.id,
            reference_name: ready.name,
            entry_name: "Example (Europe)",
            complete: true,
            matched_files: [{ file_name: "Example (Europe).z64", algorithm: "sha1" }],
            entry_file_count: 1,
          },
          {
            reference_id: ready.id,
            reference_name: ready.name,
            entry_name: "Example (Europe) (Rev 1)",
            complete: false,
            matched_files: [{ file_name: "Example (Europe) (Rev 1).z64", algorithm: "sha1" }],
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
