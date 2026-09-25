// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { SteamBatchReview, SteamEntryReview } from "../types";
import { SteamBatchEntryDialog, SteamEntryDialog } from "./SteamEntry";

const port = portDefinition();
const review: SteamEntryReview = {
  schema_version: 1,
  operation: "add_or_repair",
  port_id: port.id,
  display_name: port.name,
  steam_root: "C:\\Steam",
  steam_user_id: "12345",
  library_root: "E:\\Portcove Library",
  cli_path: "C:\\Portcove\\portcove.exe",
  cli_sha256: "c".repeat(64),
  cli_product_version: "0.1.0-alpha.2",
  shortcuts_path: "C:\\Steam\\userdata\\12345\\config\\shortcuts.vdf",
  snapshot_sha256: "before",
  proposed_sha256: "after",
  plan_sha256: "reviewed-plan",
  changes: [{ port_id: port.id, display_name: port.name, kind: "add" }],
  steam_client_state: "closed",
  writes_required: true,
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

async function input(label: string, value: string) {
  const field = [...document.body.querySelectorAll("input")].find(
    (candidate) => candidate.labels?.[0]?.textContent === label,
  );
  expect(field).toBeDefined();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("uses the selected installation and profile, shows exact consumer evidence, and applies only its plan", async () => {
  const preview = vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue(review);
  const apply = vi.spyOn(desktopApi, "applySteamEntry").mockResolvedValue({
    plan_sha256: review.plan_sha256,
    shortcuts_path: review.shortcuts_path,
    backup_path: "C:\\Steam\\userdata\\12345\\config\\shortcuts.vdf.portcove-backup",
    changes: review.changes,
    wrote: true,
  });
  await act(async () =>
    root.render(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />),
  );
  const installation = document.body.querySelector<HTMLInputElement>("#steam-installation");
  const installationLabel = document.body.querySelector<HTMLLabelElement>(
    'label[for="steam-installation"]',
  );
  expect(installation?.dataset.slot).toBe("input");
  expect(document.body.querySelector<HTMLElement>("#steam-profile")?.dataset.slot).toBe("input");
  expect(installation?.className).toContain("border-pc-input");
  expect(installation?.className).toContain("bg-[var(--color-bg-inset)]");
  expect(installationLabel?.className).toContain("text-pc-muted-foreground");
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review Add / Repair");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    port.id,
    "C:\\Steam",
    "12345",
    "add_or_repair",
    7,
  );
  for (const value of [
    review.shortcuts_path,
    review.library_root,
    review.cli_path!,
    review.cli_sha256!,
    review.cli_product_version!,
    "add",
  ])
    expect(document.body.textContent).toContain(value);
  await click("Apply reviewed Add / Repair");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    port.id,
    review.steam_root,
    review.steam_user_id,
    review.operation,
    review.plan_sha256,
    7,
  );
  expect(document.body.textContent).toContain("reviewed Steam entry change was written");
  expect(document.body.textContent).toContain("shortcuts.vdf.portcove-backup");
});

it("blocks apply while Steam is running and clears a review when the target changes", async () => {
  const preview = vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue({
    ...review,
    steam_client_state: "running",
  });
  const apply = vi.spyOn(desktopApi, "applySteamEntry");
  await act(async () =>
    root.render(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />),
  );
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review Add / Repair");
  expect(document.body.textContent).toContain("never force Steam to close");
  const applyButton = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Apply reviewed Add / Repair",
  );
  expect(applyButton?.disabled).toBe(true);
  await input("Steam profile ID", "54321");
  expect(document.body.textContent).not.toContain(review.shortcuts_path);
  expect(apply).not.toHaveBeenCalled();
  expect(preview).toHaveBeenCalledOnce();
});

it("keeps the reviewed plan visible when native consent is declined", async () => {
  vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue(review);
  vi.spyOn(desktopApi, "applySteamEntry").mockResolvedValue(null);
  await act(async () =>
    root.render(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />),
  );
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review Add / Repair");
  await click("Apply reviewed Add / Repair");
  expect(document.body.textContent).toContain(review.shortcuts_path);
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
});

it("offers owned-shortcut removal after uninstall without offering Add or Repair", async () => {
  const removeReview: SteamEntryReview = {
    ...review,
    operation: "remove",
    cli_path: null,
    cli_sha256: null,
    cli_product_version: null,
    changes: [{ port_id: port.id, display_name: port.name, kind: "remove" }],
  };
  const preview = vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue(removeReview);
  await act(async () =>
    root.render(<SteamEntryDialog port={port} generation={7} installed={false} close={vi.fn()} />),
  );
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  const add = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Review Add / Repair",
  );
  expect(add?.disabled).toBe(true);
  expect(document.body.textContent).toContain("game is not installed here");
  await click("Review Remove");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, "C:\\Steam", "12345", "remove", 7);
  expect(document.body.textContent).toContain("owned shortcut before writing");
  expect(document.body.textContent).toContain("Not required for this removal review");
});

it("reviews an exact selected batch and applies only its frozen selection", async () => {
  const second = { ...port, id: "another-port", name: "Another Port" };
  const batchReview: SteamBatchReview = {
    schema_version: 1,
    selected_games: [
      { port_id: port.id, display_name: port.name },
      { port_id: second.id, display_name: second.name },
    ],
    steam_root: review.steam_root,
    steam_user_id: review.steam_user_id,
    library_root: review.library_root,
    cli_path: review.cli_path!,
    cli_sha256: review.cli_sha256!,
    cli_product_version: review.cli_product_version!,
    shortcuts_path: review.shortcuts_path,
    snapshot_sha256: review.snapshot_sha256,
    proposed_sha256: review.proposed_sha256,
    review_sha256: "batch-review",
    writer_plan_sha256: "batch-plan",
    changes: [...review.changes, { port_id: second.id, display_name: second.name, kind: "add" }],
    steam_client_state: "closed",
    writes_required: true,
  };
  const preview = vi.spyOn(desktopApi, "previewSteamBatchAdd").mockResolvedValue(batchReview);
  const apply = vi.spyOn(desktopApi, "applySteamBatchAdd").mockResolvedValue(null);
  await act(async () =>
    root.render(<SteamBatchEntryDialog ports={[port, second]} generation={7} close={vi.fn()} />),
  );
  const reviewButton = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Review selected Add / Repair",
  );
  expect(reviewButton?.disabled).toBe(true);
  const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  await act(async () => boxes[0].click());
  expect(reviewButton?.disabled).toBe(true);
  await act(async () => boxes[1].click());
  await input("Steam installation folder", review.steam_root);
  await input("Steam profile ID", review.steam_user_id);
  await click("Review selected Add / Repair");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    {
      portIds: [port.id, second.id],
      steamRoot: review.steam_root,
      steamUserId: review.steam_user_id,
    },
    7,
  );
  expect(document.body.textContent).toContain("Selected: Another Port");
  await click("Apply reviewed batch Add / Repair");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    {
      portIds: [port.id, second.id],
      steamRoot: review.steam_root,
      steamUserId: review.steam_user_id,
    },
    "batch-review",
    7,
  );
  await act(async () => boxes[1].click());
  expect(document.body.textContent).not.toContain(review.shortcuts_path);
});
