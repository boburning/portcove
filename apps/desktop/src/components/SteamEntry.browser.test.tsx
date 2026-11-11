import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { SteamArtworkReview, SteamBatchReview, SteamEntryReview } from "../types";
import { SteamBatchEntryDialog, SteamEntryDialog } from "./SteamEntry";

const port = portDefinition();
const portraitWrite: SteamArtworkReview["roles"][number] = {
  role: "portrait_cover",
  action: "write",
  destination_path: "C:\\Steam\\userdata\\12345\\config\\grid\\2147488308p.png",
  existing_paths: [],
  existing_sha256: null,
  proposed_sha256: "a".repeat(64),
  unavailable_reason: null,
  forget_ownership: false,
};
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
  artwork: [{ port_id: port.id, roles: [portraitWrite], unavailable: null }],
  artwork_review_sha256: "reviewed-artwork",
  recovered_shortcut_change: false,
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
    artwork: [
      { port_id: port.id, roles: [portraitWrite], backup_paths: [], wrote: true, error: null },
    ],
  });
  await root.rerender(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />);
  const installation = document.body.querySelector<HTMLInputElement>("#steam-installation");
  const installationLabel = document.body.querySelector<HTMLLabelElement>(
    'label[for="steam-installation"]',
  );
  expect(installation?.dataset.slot).toBe("input");
  expect(document.body.querySelector<HTMLElement>("#steam-profile")?.dataset.slot).toBe("input");
  expect(installation?.className).toContain("border-pc-input");
  expect(installation?.className).toContain("bg-[var(--color-bg-inset)]");
  expect(installation?.labels?.[0]).toBe(installationLabel);
  expect(installationLabel?.textContent).toBe("Steam installation folder");
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review shortcut setup");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    port.id,
    "C:\\Steam",
    "12345",
    "add_or_repair",
    true,
    7,
  );
  expect(document.body.textContent).toContain(`${port.name}, portrait cover: Will be added`);
  for (const value of [
    review.shortcuts_path,
    review.library_root,
    review.cli_path!,
    review.cli_sha256!,
    review.cli_product_version!,
    "Add shortcut",
  ])
    expect(document.body.textContent).toContain(value);
  const fields = document.querySelector(".steam-profile-fields")!;
  const reviewedChange = document.querySelector('[aria-label="Reviewed Steam shortcut change"]')!;
  expect(
    reviewedChange.getBoundingClientRect().top - fields.getBoundingClientRect().bottom,
  ).toBeGreaterThanOrEqual(23);
  for (const group of [fields, reviewedChange, reviewedChange.querySelector("dl")!]) {
    const children = Array.from(group.children);
    for (let index = 1; index < children.length; index++) {
      expect(
        children[index]!.getBoundingClientRect().top -
          children[index - 1]!.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(11);
    }
  }
  await captureParityState("steam-singleton-reviewed-fixture");
  await click("Add or repair shortcut");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    port.id,
    review.steam_root,
    review.steam_user_id,
    review.operation,
    true,
    review.plan_sha256,
    "reviewed-artwork",
    7,
  );
  expect(document.body.textContent).toContain("Steam shortcut updated.");
  expect(document.body.textContent).toContain(`${port.name}, portrait cover: Added`);
  expect(document.body.textContent).toContain("shortcuts.vdf.portcove-backup");
});

it("blocks apply while Steam is running and clears a review when the target changes", async () => {
  const preview = vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue({
    ...review,
    steam_client_state: "running",
  });
  const apply = vi.spyOn(desktopApi, "applySteamEntry");
  await root.rerender(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review shortcut setup");
  expect(document.body.textContent).toContain("Close Steam, then choose Check again.");
  expect(document.body.textContent).toContain("Check again");
  const applyButton = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Add or repair shortcut",
  );
  expect(applyButton?.disabled).toBe(true);
  await captureParityState("steam-running-client-refusal-fixture");
  const refusal = page.getByText(
    "Close Steam, then choose Check again. Portcove will not close Steam for you.",
    { exact: true },
  );
  refusal.element().scrollIntoView({ block: "center" });
  await expect.element(refusal).toBeVisible();
  const checkAgain = page.getByRole("button", { name: "Check again", exact: true });
  await expect
    .poll(() =>
      [refusal.element(), checkAgain.element(), applyButton!].every((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight &&
          bounds.left >= 0 &&
          bounds.right <= innerWidth
        );
      }),
    )
    .toBe(true);
  await captureParityState("steam-running-client-refusal-lower-fixture");
  preview.mockResolvedValue({ ...review, steam_client_state: "closed" });
  await click("Check again");
  expect(preview).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Keep Steam closed until this finishes.");
  expect(
    [...document.body.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Add or repair shortcut",
    )?.disabled,
  ).toBe(false);
  await input("Steam profile ID", "54321");
  expect(document.body.textContent).not.toContain(review.shortcuts_path);
  expect(apply).not.toHaveBeenCalled();
  expect(preview).toHaveBeenCalledTimes(2);
});

it("selects an explicit discovered profile and clears it when the installation changes", async () => {
  const list = vi.spyOn(desktopApi, "listSteamProfiles").mockResolvedValue(["12345", "987"]);
  const preview = vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue(review);
  await root.rerender(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await click("Find local profiles");
  expect(list).toHaveBeenCalledExactlyOnceWith("C:\\Steam", 7);
  expect(document.body.querySelector<HTMLInputElement>("#steam-profile")?.value).toBe("");
  await click("12345");
  expect(document.body.querySelector<HTMLInputElement>("#steam-profile")?.value).toBe("12345");
  await captureParityState("steam-discovered-profile-selected-fixture");
  await click("Review shortcut setup");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    port.id,
    "C:\\Steam",
    "12345",
    "add_or_repair",
    true,
    7,
  );
  await input("Steam installation folder", "D:\\Steam");
  expect(document.body.querySelector<HTMLInputElement>("#steam-profile")?.value).toBe("");
  expect(document.body.querySelector('[aria-label="Local Steam profiles"]')).toBeNull();
  expect(document.body.textContent).not.toContain(review.shortcuts_path);
});

it("does not show discovery results after the installation changes", async () => {
  let resolveProfiles: (profiles: string[]) => void = () => {};
  vi.spyOn(desktopApi, "listSteamProfiles").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveProfiles = resolve;
      }),
  );
  await root.rerender(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await click("Find local profiles");
  await input("Steam installation folder", "D:\\Steam");
  await act(async () => resolveProfiles(["12345"]));
  expect(document.body.querySelector('[aria-label="Local Steam profiles"]')).toBeNull();
});

it("keeps the reviewed plan visible when native consent is declined", async () => {
  vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue(review);
  vi.spyOn(desktopApi, "applySteamEntry").mockResolvedValue(null);
  await root.rerender(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review shortcut setup");
  await click("Add or repair shortcut");
  expect(document.body.textContent).toContain(review.shortcuts_path);
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  await captureParityState("steam-consent-declined-fixture");
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
  await root.rerender(
    <SteamEntryDialog port={port} generation={7} installed={false} close={vi.fn()} />,
  );
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  const add = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Review shortcut setup",
  );
  expect(add?.disabled).toBe(true);
  expect(document.body.textContent).toContain("game is not installed here");
  await click("Review shortcut removal");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    port.id,
    "C:\\Steam",
    "12345",
    "remove",
    false,
    7,
  );
  expect(document.body.textContent).toContain("selected profile and shortcut are checked");
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
    artwork: [],
    artwork_review_sha256: null,
    recovered_shortcut_change: false,
  };
  const preview = vi.spyOn(desktopApi, "previewSteamBatchAdd").mockResolvedValue(batchReview);
  const apply = vi.spyOn(desktopApi, "applySteamBatchAdd").mockResolvedValue(null);
  await root.rerender(
    <SteamBatchEntryDialog ports={[port, second]} generation={7} close={vi.fn()} />,
  );
  const reviewButton = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Review selected shortcuts",
  );
  expect(reviewButton?.disabled).toBe(true);
  await page.getByRole("checkbox", { name: port.name }).click();
  expect(reviewButton?.disabled).toBe(true);
  await page.getByRole("checkbox", { name: second.name }).click();
  await input("Steam installation folder", review.steam_root);
  await input("Steam profile ID", review.steam_user_id);
  await click("Review selected shortcuts");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    {
      portIds: [port.id, second.id],
      steamRoot: review.steam_root,
      steamUserId: review.steam_user_id,
      includeArtwork: true,
    },
    7,
  );
  expect(document.body.textContent).toContain("Selected: Another Port");
  await captureParityState("steam-batch-reviewed-fixture");
  await click("Add or repair selected shortcuts");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    {
      portIds: [port.id, second.id],
      steamRoot: review.steam_root,
      steamUserId: review.steam_user_id,
      includeArtwork: true,
    },
    "batch-review",
    null,
    7,
  );
  await page.getByRole("checkbox", { name: second.name }).click();
  expect(document.body.textContent).not.toContain(review.shortcuts_path);
});

const artworkReview: SteamArtworkReview = {
  schema_version: 1,
  operation: { kind: "update", replace_existing: false },
  port_id: port.id,
  display_name: port.name,
  steam_root: "C:\\Steam",
  steam_user_id: "12345",
  app_id: 2147488308,
  grid_path: "C:\\Steam\\userdata\\12345\\config\\grid",
  plan_sha256: "reviewed-artwork-plan",
  roles: [
    {
      role: "portrait_cover",
      action: "write",
      destination_path: "C:\\Steam\\userdata\\12345\\config\\grid\\2147488308p.png",
      existing_paths: [],
      existing_sha256: null,
      proposed_sha256: "a".repeat(64),
      unavailable_reason: null,
      forget_ownership: false,
    },
    {
      role: "landscape_cover",
      action: "unavailable",
      destination_path: null,
      existing_paths: [],
      existing_sha256: null,
      proposed_sha256: null,
      unavailable_reason: "role_not_provided",
      forget_ownership: false,
    },
    {
      role: "hero_banner",
      action: "preserve",
      destination_path: null,
      existing_paths: ["C:\\Steam\\userdata\\12345\\config\\grid\\2147488308_hero.png"],
      existing_sha256: "b".repeat(64),
      proposed_sha256: null,
      unavailable_reason: null,
      forget_ownership: false,
    },
  ],
  steam_client_state: "closed",
  writes_required: true,
  recovered: null,
  recovered_shortcut_change: false,
};

it("reviews artwork separately, keeps existing art by default and applies only the reviewed plan", async () => {
  const preview = vi.spyOn(desktopApi, "previewSteamArtwork").mockResolvedValue(artworkReview);
  const apply = vi.spyOn(desktopApi, "applySteamArtwork").mockResolvedValue({
    plan_sha256: artworkReview.plan_sha256,
    roles: artworkReview.roles,
    backup_paths: [],
    wrote: true,
  });
  const shortcutPreview = vi.spyOn(desktopApi, "previewSteamEntry");
  await root.rerender(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review artwork update");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    {
      portId: port.id,
      steamRoot: "C:\\Steam",
      steamUserId: "12345",
      operation: { kind: "update", replace_existing: false },
    },
    7,
  );
  expect(shortcutPreview).not.toHaveBeenCalled();
  for (const value of [
    "Portrait cover: Will be added",
    "Landscape cover: Not available: Portcove has no image for this role yet",
    "Hero banner: Kept: Steam already has artwork here",
    artworkReview.grid_path,
  ])
    expect(document.body.textContent).toContain(value);
  expect(document.body.textContent).not.toContain("Review shortcut setup");
  await click("Update Steam artwork");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    {
      portId: port.id,
      steamRoot: "C:\\Steam",
      steamUserId: "12345",
      operation: artworkReview.operation,
    },
    artworkReview.plan_sha256,
    7,
  );
  expect(document.body.textContent).toContain(
    "Steam artwork updated. Restart Steam to see the change.",
  );
  expect(document.body.textContent).toContain("Portrait cover: Added");
});

it("requests replacement only when chosen and offers removal of Portcove artwork after uninstall", async () => {
  const preview = vi.spyOn(desktopApi, "previewSteamArtwork").mockResolvedValue({
    ...artworkReview,
    operation: { kind: "remove_owned" },
    recovered: { completed: [], abandoned: ["portrait_cover"] },
    roles: artworkReview.roles.map((role) => ({
      ...role,
      action: role.role === "portrait_cover" ? "preserve_modified" : "absent",
      forget_ownership: role.role === "portrait_cover",
    })),
    steam_client_state: "running",
  });
  const apply = vi.spyOn(desktopApi, "applySteamArtwork");
  await root.rerender(
    <SteamEntryDialog port={port} generation={3} installed={false} close={vi.fn()} />,
  );
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  const replace = document.body.querySelector<HTMLElement>("[data-steam-artwork-replace]");
  await act(async () => replace?.click());
  await click("Review artwork update");
  expect(preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: { kind: "update", replace_existing: true } }),
    3,
  );
  await click("Check again");
  // Changing the selected profile clears the artwork review and returns to the choices.
  await input("Steam profile ID", "1234");
  await input("Steam profile ID", "12345");
  await click("Review artwork removal");
  expect(preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: { kind: "remove_owned" } }),
    3,
  );
  expect(document.body.textContent).toContain(
    "Portrait cover: Kept: it was changed outside Portcove",
  );
  expect(document.body.textContent).toContain("Close Steam, then choose Check again.");
  expect(document.body.textContent).toContain(
    "Portcove first finished an interrupted artwork change for this profile.",
  );
  const removeButton = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove Portcove artwork",
  );
  expect(removeButton?.disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});

it("adds a shortcut without artwork when Include artwork is cleared and reports an artwork failure separately", async () => {
  const preview = vi.spyOn(desktopApi, "previewSteamEntry").mockResolvedValue({
    ...review,
    artwork: [],
    artwork_review_sha256: null,
    recovered_shortcut_change: true,
  });
  const apply = vi.spyOn(desktopApi, "applySteamEntry").mockResolvedValue({
    plan_sha256: review.plan_sha256,
    shortcuts_path: review.shortcuts_path,
    backup_path: null,
    changes: review.changes,
    wrote: true,
    artwork: [
      {
        port_id: port.id,
        roles: [],
        backup_paths: [],
        wrote: false,
        error: "Steam artwork changed after review; use Review artwork update",
      },
    ],
  });
  await root.rerender(<SteamEntryDialog port={port} generation={5} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await page.getByRole("checkbox", { name: "Include artwork when adding a shortcut" }).click();
  await click("Review shortcut setup");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    port.id,
    "C:\\Steam",
    "12345",
    "add_or_repair",
    false,
    5,
  );
  expect(document.body.querySelector('[aria-label="Included Steam artwork"]')).toBeNull();
  expect(document.body.textContent).toContain(
    "Portcove first finished an interrupted shortcut change for this profile.",
  );
  await click("Add or repair shortcut");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    port.id,
    review.steam_root,
    review.steam_user_id,
    review.operation,
    false,
    review.plan_sha256,
    null,
    5,
  );
  expect(document.body.textContent).toContain("Steam shortcut updated.");
  expect(document.body.textContent).toContain(
    `${port.name}: shortcut added; artwork was not completed.`,
  );
});
