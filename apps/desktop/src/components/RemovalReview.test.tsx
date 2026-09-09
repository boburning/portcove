// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { PortRemovalPreview } from "../types";
import { RemovalReviewDialog } from "./RemovalReview";

const port = portDefinition();
const review: PortRemovalPreview = { port_id: port.id, managed_paths: ["library/versions/current", "external/versions/retained"], persistent_data_path: "library/user/game", persistent_data_will_be_preserved: true, preview_sha256: "reviewed-installations" };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === label);
  expect(button).toBeDefined(); await act(async () => button?.click());
}

it("lists every affected path, removed settings and preserved data before explicit consent", async () => {
  const preview = vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  const apply = vi.fn().mockResolvedValue(true); const close = vi.fn();
  await act(async () => root.render(<RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />));
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, 7);
  expect(apply).not.toHaveBeenCalled();
  for (const path of [...review.managed_paths, review.persistent_data_path]) expect(container.textContent).toContain(path);
  for (const text of ["2 managed folders", "release-channel and update-policy settings", "original folders", "retains a recovery journal", "not an undo"]) expect(container.textContent).toContain(text);
  expect(container.querySelector('[data-autofocus]')?.textContent).toBe("Keep installed files");
  await click("Remove these managed folders");
  expect(apply).toHaveBeenCalledExactlyOnceWith("reviewed-installations"); expect(close).toHaveBeenCalledOnce();
});

it("dismisses a removal review without applying it", async () => {
  vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  const apply = vi.fn(); const close = vi.fn();
  await act(async () => root.render(<RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />));
  await click("Keep installed files");
  expect(close).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
});

it("closes the review without an error when final native consent is declined", async () => {
  vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  const apply = vi.fn().mockResolvedValue("cancelled"); const close = vi.fn();
  await act(async () => root.render(<RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />));
  await click("Remove these managed folders");
  expect(close).toHaveBeenCalledOnce(); expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("blocks duplicate removal and requires a new review after failure", async () => {
  const preview = vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  let finish!: (result: boolean) => void;
  const apply = vi.fn().mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const close = vi.fn();
  await act(async () => root.render(<RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />));
  await click("Remove these managed folders"); await click("Removing reviewed files…"); await click("Keep installed files");
  expect(apply).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("did not complete");
  expect(container.textContent).not.toContain("Remove these managed folders");
  await click("Review removal again"); expect(preview).toHaveBeenCalledTimes(2);
});

it("ignores a late review from the previous library", async () => {
  let finish!: (result: PortRemovalPreview) => void;
  vi.spyOn(desktopApi, "previewRemoval").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...review, managed_paths: ["new-library/versions/current"] });
  const apply = vi.fn(); const close = vi.fn();
  await act(async () => root.render(<RemovalReviewDialog key="old" port={port} generation={7} apply={apply} close={close} />));
  await act(async () => root.render(<RemovalReviewDialog key="new" port={port} generation={8} apply={apply} close={close} />));
  await act(async () => finish(review));
  expect(container.textContent).toContain("new-library/versions/current");
  expect(container.textContent).not.toContain("external/versions/retained");
  expect(apply).not.toHaveBeenCalled();
});
