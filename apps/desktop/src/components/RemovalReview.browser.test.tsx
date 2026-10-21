import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { portDefinition, portStatus } from "../test-fixtures";
import type { PortRemovalPreview } from "../types";
import { RemovalReviewDialog, RemovalControl } from "./RemovalReview";

const port = portDefinition();
const review: PortRemovalPreview = {
  port_id: port.id,
  managed_paths: ["library/versions/current", "external/versions/retained"],
  persistent_data_path: "library/user/game",
  persistent_data_will_be_preserved: true,
  preview_sha256: "reviewed-installations",
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
async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

function dialog() {
  const result = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  expect(result).not.toBeNull();
  return result!;
}

it("focuses the safe action through asynchronous review and returns to the opener on Escape", async () => {
  let settle!: (value: PortRemovalPreview) => void;
  vi.spyOn(desktopApi, "previewRemoval").mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  await root.rerender(
    <RemovalControl
      port={port}
      status={{
        ...portStatus(),
        port_actions: [{ action: "remove_managed", availability: "allowed", reason: "available" }],
      }}
      generation={7}
      busy={false}
      apply={vi.fn()}
    />,
  );
  const opener = page.getByRole("button", { name: `Uninstall ${port.name}`, exact: true });
  await opener.click();
  await expect.poll(() => document.activeElement?.textContent).toBe("Cancel");
  expect(dialog().textContent).toContain("Checking installed versions");
  await act(async () => settle(review));
  expect(dialog().textContent).toContain(review.persistent_data_path);
  expect(document.activeElement?.textContent).toBe("Cancel");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  await expect.element(opener).toHaveFocus();
});

it.each(
  [
    undefined,
    {
      ...portStatus(),
      port_actions: [{ action: "launch", availability: "allowed", reason: "available" }],
    },
  ].map((status, index) => ({ name: index === 0 ? "missing status" : "missing action", status })),
)("does not load a removal preview for $name", async ({ status }) => {
  const preview = vi.spyOn(desktopApi, "previewRemoval");
  await root.rerender(
    <RemovalControl
      port={port}
      status={status as never}
      generation={7}
      busy={false}
      apply={vi.fn()}
    />,
  );
  const button = document.body.querySelector<HTMLButtonElement>("button");
  expect(button?.disabled).toBe(true);
  await act(async () => button?.click());
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
});

it("lists every affected path, removed settings and preserved data before explicit consent", async () => {
  const preview = vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  const apply = vi.fn().mockResolvedValue(true);
  const close = vi.fn();
  await root.rerender(
    <RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />,
  );
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, 7);
  expect(apply).not.toHaveBeenCalled();
  for (const path of [...review.managed_paths, review.persistent_data_path])
    expect(dialog().textContent).toContain(path);
  for (const text of [
    "2 installation folders",
    `Uninstall ${port.name}?`,
    `all installed versions of ${port.name} managed by Portcove`,
    "release-channel and update-policy settings",
    "original folders",
    "Your saved data, backups, and game files are kept",
    "reinstall it or copy an existing installation",
    "retains a recovery journal",
    "interrupted deletion may finish",
  ])
    expect(dialog().textContent).toContain(text);
  expect(dialog().textContent).toContain("original folders used for copied installations");
  expect(dialog().textContent?.toLowerCase()).not.toContain("adoption");
  await expect.poll(() => document.activeElement?.textContent).toBe("Cancel");
  await click("Uninstall all versions");
  expect(apply).toHaveBeenCalledExactlyOnceWith("reviewed-installations");
  expect(close).toHaveBeenCalledOnce();
});

it("dismisses a removal review without applying it", async () => {
  vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  const apply = vi.fn();
  const close = vi.fn();
  await root.rerender(
    <RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />,
  );
  await click("Cancel");
  expect(close).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("closes the review without an error when final native consent is declined", async () => {
  vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  const apply = vi.fn().mockResolvedValue("cancelled");
  const close = vi.fn();
  await root.rerender(
    <RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />,
  );
  await click("Uninstall all versions");
  expect(close).toHaveBeenCalledOnce();
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
});

it("blocks duplicate removal and requires a new review after failure", async () => {
  const preview = vi.spyOn(desktopApi, "previewRemoval").mockResolvedValue(review);
  let finish!: (result: boolean) => void;
  const apply = vi.fn().mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  await root.rerender(
    <RemovalReviewDialog port={port} generation={7} apply={apply} close={close} />,
  );
  await click("Uninstall all versions");
  await click("Uninstalling…");
  await click("Cancel");
  expect(apply).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("did not complete");
  expect(
    [...dialog().querySelectorAll("button")].some(
      (button) => button.textContent === "Uninstall all versions",
    ),
  ).toBe(false);
  await click("Review removal again");
  expect(preview).toHaveBeenCalledTimes(2);
});

it("ignores a late review from the previous library", async () => {
  let finish!: (result: PortRemovalPreview) => void;
  vi.spyOn(desktopApi, "previewRemoval")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      ...review,
      managed_paths: ["new-library/versions/current"],
    });
  const apply = vi.fn();
  const close = vi.fn();
  await root.rerender(
    <RemovalReviewDialog key="old" port={port} generation={7} apply={apply} close={close} />,
  );
  await root.rerender(
    <RemovalReviewDialog key="new" port={port} generation={8} apply={apply} close={close} />,
  );
  await act(async () => finish(review));
  expect(dialog().textContent).toContain("new-library/versions/current");
  expect(dialog().textContent).not.toContain("external/versions/retained");
  expect(apply).not.toHaveBeenCalled();
});
