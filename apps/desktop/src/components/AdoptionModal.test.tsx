// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { portDefinition } from "../test-fixtures";
import { AdoptionModal } from "./AdoptionModal";

it("keeps an uncancellable copy open and inputs locked even while another operation is busy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  try {
    await act(async () =>
      root.render(
        <AdoptionModal
          path="owned/original"
          setPath={vi.fn()}
          close={close}
          review={vi.fn()}
          adopt={vi.fn()}
          pickFolder={vi.fn()}
          applying
          busy="refresh"
          copyFailed
        />,
      ),
    );
    const dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector("#adopt-path")?.getAttribute("data-slot")).toBe("input");
    expect(dialog.classList.contains("modal")).toBe(false);
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "button, input",
    ))
      expect(control.disabled).toBe(true);
    await act(async () => {
      dialog
        .querySelector<HTMLButtonElement>('[aria-label="Close copy installation dialog"]')!
        .click();
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(close).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "Check the library and activity history",
    );
    expect(dialog.textContent).toContain("Copying…");
    expect(dialog.textContent).not.toContain("Waiting for copy");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows the reviewed copy plan and skipped entries in the portaled Dialog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const port = { ...portDefinition(), id: "sample", name: "Sample Port" };
  try {
    await act(async () =>
      root.render(
        <AdoptionModal
          path="D:/Existing"
          setPath={vi.fn()}
          close={vi.fn()}
          review={vi.fn()}
          adopt={vi.fn()}
          ports={[port]}
          preview={{
            source: "D:/Existing",
            detected_port_ids: [port.id],
            selected_port_id: port.id,
            application_files_will_be_copied: true,
            original_will_be_modified: false,
            copy_plan: {
              directories: ["data"],
              files: [{ relative_path: "sample.exe", size: 2048, sha256: "a".repeat(64) }],
              skipped_entries: [
                { relative_path: "linked-save", reason: "symbolic links are not copied" },
              ],
              total_bytes: 2048,
            },
            destination: {
              output_location: {
                port_id: port.id,
                library_root: "D:/Library",
                default_output_directory: "D:/Library/versions/sample",
                configured_output_directory: "E:/Games",
                effective_output_directory: "E:/Games",
                selection_source: "port_setting",
                user_data_root: "D:/Library/user/sample",
              },
              active_install: null,
              imported_user_data_paths: ["settings"],
              current_user_data_files: 2,
              current_user_data_sha256: "c".repeat(64),
            },
            plan_sha256: "b".repeat(64),
          }}
        />,
      ),
    );
    const dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    for (const expected of [
      "1 file · 2.0 KiB",
      "Sample Port",
      "1 unsupported item will remain only in the original folder",
      "linked-save",
      "Continue to copy confirmation",
      "E:/Games",
      "D:/Library/user/sample",
      "Matching saved files are replaced",
      "No automatic safety backup",
      "cannot cancel",
    ])
      expect(dialog.textContent).toContain(expected);
    expect(dialog.textContent).not.toContain("SAFE ADOPTION");
    expect(dialog.textContent).not.toContain("Bring an existing install into Portcove");
    expect([...dialog.querySelectorAll("code")].map((item) => item.textContent)).toContain(port.id);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("offers only detected ports for a fresh bound copy review", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const port = { ...portDefinition(), id: "sample", name: "Sample Port" };
  const other = { ...port, id: "other", name: "Other Port" };
  const review = vi.fn();
  try {
    await act(async () =>
      root.render(
        <AdoptionModal
          path="D:/Ambiguous"
          setPath={vi.fn()}
          close={vi.fn()}
          review={review}
          adopt={vi.fn()}
          ports={[port, other]}
          preview={{
            source: "D:/Ambiguous",
            detected_port_ids: [port.id, other.id],
            selected_port_id: null,
            application_files_will_be_copied: true,
            original_will_be_modified: false,
            copy_plan: {
              directories: [],
              files: [],
              skipped_entries: [],
              total_bytes: 0,
            },
            destination: null,
            plan_sha256: "d".repeat(64),
          }}
        />,
      ),
    );
    const dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    expect(dialog.textContent).toContain("Multiple supported ports detected");
    expect(dialog.textContent).toContain("Review Sample Port — Catalog ID: sample");
    expect(dialog.textContent).toContain("Review Other Port — Catalog ID: other");
    expect(dialog.textContent).toContain("Choose the correct game");
    expect(
      [...dialog.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("Continue to copy confirmation"),
      )?.disabled,
    ).toBe(true);
    await act(async () => {
      [...dialog.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("Review Other Port"))!
        .click();
    });
    expect(review).toHaveBeenCalledExactlyOnceWith("other");
    expect(dialog.textContent).toContain("Cancel");
    expect(dialog.querySelector("strong")?.textContent).toBe("Multiple supported ports detected");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
