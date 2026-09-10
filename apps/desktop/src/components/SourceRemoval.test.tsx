// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { SourceRemovalPreview } from "../types";
import { SourceRemovalControl, SourceRemovalDialog } from "./SourceRemoval";

const ports = [
  { ...portDefinition(), id: "installed", name: "Installed game" },
  { ...portDefinition(), id: "other", name: "Another compatible game" },
];
const preview: SourceRemovalPreview = {
  source: {
    profile_id: "source",
    path: "original/game.bin",
    sha256: "a".repeat(64),
    storage_sha256: "a".repeat(64),
    size: 10,
    storage_size: 10,
    updated_at: 1,
  },
  dependent_port_ids: ["installed", "other"],
  installed_dependent_port_ids: ["installed"],
  preview_sha256: "reviewed-source-impact",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(result).toBeDefined();
  return result!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

it("shows the original path, installed impact and all dependents without removing anything", async () => {
  const read = vi
    .spyOn(desktopApi, "previewSourceRemoval")
    .mockResolvedValue(preview);
  const remove = vi.spyOn(desktopApi, "removeSource");
  const close = vi.fn();
  await act(async () =>
    root.render(
      <SourceRemovalDialog
        profileId="source"
        generation={3}
        ports={ports}
        close={close}
        onRemoved={vi.fn()}
      />,
    ),
  );
  expect(read).toHaveBeenCalledExactlyOnceWith("source", 3);
  for (const text of [
    preview.source.path,
    "Installed game",
    "Another compatible game",
    "Only this library's reference",
    "never schedules deletion",
    "no one-click undo",
  ])
    expect(container.textContent).toContain(text);
  expect(container.querySelector("[data-autofocus]")?.textContent).toBe(
    "Keep source reference",
  );
  await click("Keep source reference");
  expect(close).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
});

it("binds application to the review and does not treat native cancellation as removal", async () => {
  vi.spyOn(desktopApi, "previewSourceRemoval").mockResolvedValue(preview);
  const remove = vi.spyOn(desktopApi, "removeSource").mockResolvedValue(null);
  const close = vi.fn();
  const removed = vi.fn();
  await act(async () =>
    root.render(
      <SourceRemovalDialog
        profileId="source"
        generation={3}
        ports={ports}
        close={close}
        onRemoved={removed}
      />,
    ),
  );
  await click("Continue to removal confirmation");
  expect(remove).toHaveBeenCalledExactlyOnceWith(
    "source",
    "reviewed-source-impact",
    3,
  );
  expect(close).toHaveBeenCalledOnce();
  expect(removed).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("blocks duplicate submissions within one event batch and requires fresh intent after rejection", async () => {
  const read = vi
    .spyOn(desktopApi, "previewSourceRemoval")
    .mockResolvedValue(preview);
  let reject!: (value: Error) => void;
  const remove = vi
    .spyOn(desktopApi, "removeSource")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    )
    .mockResolvedValue(preview);
  const close = vi.fn();
  const removed = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <SourceRemovalDialog
        profileId="source"
        generation={3}
        ports={ports}
        close={close}
        onRemoved={removed}
      />,
    ),
  );
  await act(async () => {
    const submit = button("Continue to removal confirmation");
    submit.click();
    submit.click();
  });
  await click("Keep source reference");
  expect(remove).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("Source or dependents changed")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Source or dependents changed",
  );
  expect(container.textContent).not.toContain(
    "Continue to removal confirmation",
  );
  await click("Review source removal again");
  expect(read).toHaveBeenCalledTimes(2);
  await click("Continue to removal confirmation");
  expect(removed).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("ignores a late preview from a previous source or library", async () => {
  let finish!: (value: SourceRemovalPreview) => void;
  vi.spyOn(desktopApi, "previewSourceRemoval")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      ...preview,
      source: {
        ...preview.source,
        profile_id: "new",
        path: "new-original/game.bin",
      },
      installed_dependent_port_ids: [],
    });
  const close = vi.fn();
  const removed = vi.fn();
  await act(async () =>
    root.render(
      <SourceRemovalDialog
        profileId="source"
        generation={3}
        ports={ports}
        close={close}
        onRemoved={removed}
      />,
    ),
  );
  await act(async () =>
    root.render(
      <SourceRemovalDialog
        profileId="new"
        generation={4}
        ports={ports}
        close={close}
        onRemoved={removed}
      />,
    ),
  );
  await act(async () => finish(preview));
  expect(container.textContent).toContain("new-original/game.bin");
  expect(container.textContent).toContain(
    "No installed game currently depends",
  );
  expect(container.textContent).not.toContain("Reference to remove: source");
});

it("retries only the list refresh after a completed removal has a refresh failure", async () => {
  vi.spyOn(desktopApi, "previewSourceRemoval").mockResolvedValue(preview);
  const remove = vi
    .spyOn(desktopApi, "removeSource")
    .mockResolvedValue(preview);
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <SourceRemovalControl
        source={preview.source}
        generation={3}
        ports={ports}
        disabled={false}
        onRemoved={refresh}
      />,
    ),
  );
  await click("Remove reference");
  await click("Continue to removal confirmation");
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "The reference was removed",
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await click("Refresh source list");
  expect(remove).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("never commits an old source preview under a new identity", async () => {
  vi.spyOn(desktopApi, "previewSourceRemoval")
    .mockResolvedValueOnce(preview)
    .mockImplementation(() => new Promise(() => {}));
  const observations: string[] = [];
  const close = vi.fn();
  const removed = vi.fn();
  function Context({ profileId }: { profileId: string }) {
    useLayoutEffect(() => {
      observations.push(container.textContent ?? "");
    }, [profileId]);
    return (
      <SourceRemovalDialog
        profileId={profileId}
        generation={3}
        ports={ports}
        close={close}
        onRemoved={removed}
      />
    );
  }
  await act(async () => root.render(<Context profileId="source" />));
  expect(container.textContent).toContain("original/game.bin");
  await act(async () => root.render(<Context profileId="new" />));
  expect(observations.at(-1)).not.toContain("original/game.bin");
  expect(container.textContent).not.toContain(
    "Continue to removal confirmation",
  );
});
