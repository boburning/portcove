import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { SourceRemovalPreview } from "../types";
import { SourceRemovalControl, SourceRemovalReview } from "./SourceRemoval";

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
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const result = [...document.body.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(result).toBeDefined();
  return result!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function impact() {
  const result = document.body.querySelector<HTMLElement>(
    '[aria-label="Saved-location removal impact"]',
  );
  expect(result).not.toBeNull();
  return result!;
}

it("requires fresh intent after location identity changes and never opens renderer approval", async () => {
  const read = vi.spyOn(desktopApi, "previewSourceRemoval").mockResolvedValue(preview);
  const remove = vi.spyOn(desktopApi, "removeSource");
  const control = (source = preview.source) => (
    <SourceRemovalControl source={source} generation={3} ports={ports} disabled={false} />
  );
  await root.rerender(control());
  expect(read).not.toHaveBeenCalled();
  await click("Review saved location removal");
  expect(read).toHaveBeenCalledOnce();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(impact().textContent).toContain(preview.source.path);
  await root.rerender(control({ ...preview.source, path: "新しい場所/game.bin" }));
  expect(document.body.querySelector('[aria-label="Saved-location removal impact"]')).toBeNull();
  await root.rerender(control());
  expect(document.body.querySelector('[aria-label="Saved-location removal impact"]')).toBeNull();
  expect(read).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  await click("Review saved location removal");
  expect(read).toHaveBeenCalledTimes(2);
});

it("shows the original path, installed impact and all dependents without removing anything", async () => {
  const read = vi.spyOn(desktopApi, "previewSourceRemoval").mockResolvedValue(preview);
  const remove = vi.spyOn(desktopApi, "removeSource");
  const close = vi.fn();
  await root.rerender(
    <SourceRemovalReview
      profileId="source"
      generation={3}
      ports={ports}
      close={close}
      onRemoved={vi.fn()}
    />,
  );
  expect(read).toHaveBeenCalledExactlyOnceWith("source", 3);
  for (const text of [
    preview.source.path,
    "Installed game",
    "Another compatible game",
    "Only this library's location",
    "does not move or delete files at",
    "If interrupted, reopen Settings",
  ])
    expect(impact().textContent).toContain(text);
  expect(impact().textContent).not.toContain("will stay at");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await click("Keep location");
  expect(close).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
});

it("binds application to the review and does not treat native cancellation as removal", async () => {
  vi.spyOn(desktopApi, "previewSourceRemoval").mockResolvedValue(preview);
  const remove = vi.spyOn(desktopApi, "removeSource").mockResolvedValue(null);
  const close = vi.fn();
  const removed = vi.fn();
  await root.rerender(
    <SourceRemovalReview
      profileId="source"
      generation={3}
      ports={ports}
      close={close}
      onRemoved={removed}
    />,
  );
  await click("Remove saved location…");
  expect(remove).toHaveBeenCalledExactlyOnceWith("source", "reviewed-source-impact", 3);
  expect(close).toHaveBeenCalledOnce();
  expect(removed).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
});

it("blocks duplicate submissions within one event batch and requires fresh intent after rejection", async () => {
  const read = vi.spyOn(desktopApi, "previewSourceRemoval").mockResolvedValue(preview);
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
  await root.rerender(
    <SourceRemovalReview
      profileId="source"
      generation={3}
      ports={ports}
      close={close}
      onRemoved={removed}
    />,
  );
  await act(async () => {
    const submit = button("Remove saved location…");
    submit.click();
    submit.click();
  });
  await click("Keep location");
  expect(remove).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("Source or dependents changed")));
  expect(impact().querySelector('[role="alert"]')?.textContent).toContain(
    "Source or dependents changed",
  );
  expect(
    [...impact().querySelectorAll("button")].some(
      (button) => button.textContent === "Remove saved location…",
    ),
  ).toBe(false);
  await click("Check saved location again");
  expect(read).toHaveBeenCalledTimes(2);
  await click("Remove saved location…");
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
  await root.rerender(
    <SourceRemovalReview
      profileId="source"
      generation={3}
      ports={ports}
      close={close}
      onRemoved={removed}
    />,
  );
  await root.rerender(
    <SourceRemovalReview
      profileId="new"
      generation={4}
      ports={ports}
      close={close}
      onRemoved={removed}
    />,
  );
  await act(async () => finish(preview));
  expect(impact().textContent).toContain("new-original/game.bin");
  expect(impact().textContent).toContain("No installed game currently depends");
  expect(impact().textContent).not.toContain("Reference to remove: source");
});

it("retries only the list refresh after a completed removal has a refresh failure", async () => {
  vi.spyOn(desktopApi, "previewSourceRemoval").mockResolvedValue(preview);
  const remove = vi.spyOn(desktopApi, "removeSource").mockResolvedValue(preview);
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValue(undefined);
  await root.rerender(
    <SourceRemovalControl
      source={preview.source}
      generation={3}
      ports={ports}
      disabled={false}
      onRemoved={refresh}
    />,
  );
  await click("Review saved location removal");
  await click("Remove saved location…");
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "The saved location was removed",
  );
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await click("Refresh saved-file list");
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
      observations.push(document.body.textContent ?? "");
    }, [profileId]);
    return (
      <SourceRemovalReview
        profileId={profileId}
        generation={3}
        ports={ports}
        close={close}
        onRemoved={removed}
      />
    );
  }
  await root.rerender(<Context profileId="source" />);
  expect(impact().textContent).toContain("original/game.bin");
  await root.rerender(<Context profileId="new" />);
  expect(observations.at(-1)).not.toContain("original/game.bin");
  expect(
    [...impact().querySelectorAll("button")].some(
      (button) => button.textContent === "Remove saved location…",
    ),
  ).toBe(false);
});
