// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { SteamEntryReview } from "../types";
import { SteamEntryDialog } from "./SteamEntry";

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
  const field = [...container.querySelectorAll("input")].find(
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
  const button = [...container.querySelectorAll("button")].find(
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
    root.render(<SteamEntryDialog port={port} generation={7} close={vi.fn()} />),
  );
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
    expect(container.textContent).toContain(value);
  await click("Apply reviewed Add / Repair");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    port.id,
    review.steam_root,
    review.steam_user_id,
    review.operation,
    review.plan_sha256,
    7,
  );
  expect(container.textContent).toContain("reviewed Steam entry change was written");
  expect(container.textContent).toContain("shortcuts.vdf.portcove-backup");
});

it("blocks apply while Steam is running and clears a review when the target changes", async () => {
  const preview = vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue({
    ...review,
    steam_client_state: "running",
  });
  const apply = vi.spyOn(desktopApi, "applySteamEntry");
  await act(async () =>
    root.render(<SteamEntryDialog port={port} generation={7} close={vi.fn()} />),
  );
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review Add / Repair");
  expect(container.textContent).toContain("never force Steam to close");
  const applyButton = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Apply reviewed Add / Repair",
  );
  expect(applyButton?.disabled).toBe(true);
  await input("Steam profile ID", "54321");
  expect(container.textContent).not.toContain(review.shortcuts_path);
  expect(apply).not.toHaveBeenCalled();
  expect(preview).toHaveBeenCalledOnce();
});

it("keeps the reviewed plan visible when native consent is declined", async () => {
  vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue(review);
  vi.spyOn(desktopApi, "applySteamEntry").mockResolvedValue(null);
  await act(async () =>
    root.render(<SteamEntryDialog port={port} generation={7} close={vi.fn()} />),
  );
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review Add / Repair");
  await click("Apply reviewed Add / Repair");
  expect(container.textContent).toContain(review.shortcuts_path);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
