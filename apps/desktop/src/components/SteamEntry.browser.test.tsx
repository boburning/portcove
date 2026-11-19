import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type {
  PortDefinition,
  SteamArtworkReview,
  SteamBatchReview,
  SteamEntryReview,
} from "../types";
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

it.each(["single", "batch"] as const)(
  "offers discovered installation paths in the %s shortcut flow before profile selection",
  async (flow) => {
    const custom = "D:\\Games\\Steam";
    const flatpak = "/home/player/.var/app/com.valvesoftware.Steam/.local/share/Steam";
    const discover = vi
      .spyOn(desktopApi, "discoverSteamClientRoots")
      .mockResolvedValue([custom, flatpak]);
    const profiles = vi.spyOn(desktopApi, "listSteamProfiles").mockResolvedValue(["12345"]);
    await root.rerender(
      flow === "single" ? (
        <SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />
      ) : (
        <SteamBatchEntryDialog ports={[port]} generation={7} close={vi.fn()} />
      ),
    );
    await click("Find Steam installations");
    expect(discover).toHaveBeenCalledExactlyOnceWith(7);
    const rootInput = page.getByLabelText("Steam installation folder");
    const profileInput = page.getByLabelText("Steam profile ID");
    await expect.element(rootInput).toHaveValue("");
    await click(custom);
    await expect.element(rootInput).toHaveValue(custom);
    await expect.element(profileInput).toHaveValue("");
    expect(profiles).not.toHaveBeenCalled();
    await click("Find local profiles");
    expect(profiles).toHaveBeenCalledExactlyOnceWith(custom, 7);
    await click("12345");
    await expect.element(profileInput).toHaveValue("12345");
    await click(flatpak);
    await expect.element(rootInput).toHaveValue(flatpak);
    await expect.element(profileInput).toHaveValue("");
  },
);

it("keeps manual Steam selection available when discovery has no results", async () => {
  vi.spyOn(desktopApi, "discoverSteamClientRoots").mockResolvedValue([]);
  await root.rerender(<SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />);
  await click("Find Steam installations");
  await expect
    .element(page.getByText(/No local Steam installations with profiles found/))
    .toBeVisible();
  await input("Steam installation folder", "/custom/Steam");
  await expect
    .element(page.getByLabelText("Steam installation folder"))
    .toHaveValue("/custom/Steam");
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

function batchReviewFor(second: PortDefinition): SteamBatchReview {
  return {
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
}

it("reviews an exact selected batch and applies only its frozen selection", async () => {
  const second = { ...port, id: "another-port", name: "Another Port" };
  const batchReview = batchReviewFor(second);
  const preview = vi.spyOn(desktopApi, "previewSteamBatchAdd").mockResolvedValue(batchReview);
  let declineConsent!: () => void;
  const consent = new Promise<null>((resolve) => {
    declineConsent = () => resolve(null);
  });
  const apply = vi.spyOn(desktopApi, "applySteamBatchAdd").mockReturnValue(consent);
  const close = vi.fn();
  await root.rerender(
    <SteamBatchEntryDialog ports={[port, second]} generation={7} close={close} />,
  );
  await expect
    .element(page.getByRole("heading", { name: "Add selected games to Steam" }))
    .toHaveFocus();
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
  const applyButton = page.getByRole("button", { name: "Add or repair selected shortcuts" });
  await applyButton.click();
  const updating = page.getByRole("button", { name: "Updating shortcuts…" });
  await expect.element(updating).toHaveFocus();
  await expect.element(updating).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Add selected games to Steam" }))
    .toBeVisible();
  expect(close).not.toHaveBeenCalled();
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
  await act(async () => declineConsent());
  await expect.element(applyButton).toHaveFocus();
  const button = applyButton.element();
  const popup = button.closest('[role="dialog"]')!;
  expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    popup.getBoundingClientRect().bottom + 1,
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Steam shortcut changes were cancelled.");
  await page.getByRole("checkbox", { name: second.name }).click();
  expect(document.body.textContent).not.toContain(review.shortcuts_path);
  expect(document.body.textContent).not.toContain("Steam shortcut changes were cancelled.");
});

it.each([true, false])(
  "hands a failed batch back to its review only with Apply focus (%s)",
  async (applyOwnsFocus) => {
    const second = { ...port, id: "another-port", name: "Another Port" };
    const preview = vi
      .spyOn(desktopApi, "previewSteamBatchAdd")
      .mockResolvedValue(batchReviewFor(second));
    let rejectApply!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectApply = reject;
    });
    vi.spyOn(desktopApi, "applySteamBatchAdd").mockReturnValue(pending);
    await root.rerender(
      <SteamBatchEntryDialog ports={[port, second]} generation={7} close={vi.fn()} />,
    );
    await page.getByRole("checkbox", { name: port.name }).click();
    await page.getByRole("checkbox", { name: second.name }).click();
    await input("Steam installation folder", review.steam_root);
    await input("Steam profile ID", review.steam_user_id);
    await click("Review selected shortcuts");
    await page.getByRole("button", { name: "Add or repair selected shortcuts" }).click();
    await expect.element(page.getByRole("button", { name: "Updating shortcuts…" })).toHaveFocus();
    const heading = page.getByRole("heading", { name: "Add selected games to Steam" });
    if (!applyOwnsFocus) (heading.element() as HTMLElement).focus();

    const message = "Steam shortcut review changed. Review the selected shortcuts again.";
    await act(async () => rejectApply(new Error(message)));
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
    const retry = page.getByRole("button", { name: "Review selected shortcuts" });
    await expect.element(applyOwnsFocus ? retry : heading).toHaveFocus();
    if (applyOwnsFocus) await userEvent.keyboard("{Enter}");
    else await retry.click();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[1]).toEqual(preview.mock.calls[0]);
  },
);

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
      unavailable_reason: "no_local_original",
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
  withdrawn_sources: [],
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
    "Landscape cover: Not available: choose a wide landscape image for this game in Portcove first",
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
  // Only changed art remains, so the action forgets it rather than removing.
  const removeButton = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop tracking changed artwork",
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
    "Portcove first finished an interrupted Steam shortcut or artwork change for this profile.",
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

it("points out a Steam image whose SteamGridDB source was removed and reviews removing only it", async () => {
  const evictedAt = 1_790_000_000;
  const owned = {
    ...artworkReview.roles[0]!,
    action: "unavailable" as const,
    destination_path: null,
    existing_paths: ["C:\\Steam\\userdata\\12345\\config\\grid\\2147488308p.png"],
    existing_sha256: "b".repeat(64),
    proposed_sha256: null,
    unavailable_reason: "selected_original_unavailable" as const,
  };
  const removal: SteamArtworkReview = {
    ...artworkReview,
    operation: { kind: "remove_owned_role", role: "portrait_cover" },
    roles: [{ ...owned, action: "remove", forget_ownership: true }],
    writes_required: true,
    withdrawn_sources: [{ role: "portrait_cover", source_evicted_at: evictedAt }],
    plan_sha256: "single-role-plan",
  };
  const preview = vi
    .spyOn(desktopApi, "previewSteamArtwork")
    .mockResolvedValueOnce({
      ...artworkReview,
      roles: [owned, ...artworkReview.roles.slice(1)],
      withdrawn_sources: [{ role: "portrait_cover", source_evicted_at: evictedAt }],
    })
    .mockResolvedValueOnce(removal);
  const apply = vi.spyOn(desktopApi, "applySteamArtwork").mockResolvedValue({
    plan_sha256: removal.plan_sha256,
    roles: removal.roles,
    backup_paths: ["C:\\Steam\\userdata\\12345\\config\\portcove-steam-artwork-backup.png"],
    wrote: true,
  });
  await root.rerender(<SteamEntryDialog port={port} generation={4} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review artwork update");
  expect(document.body.textContent).toContain(
    `This Steam image came from SteamGridDB, which no longer lists it. Portcove removed its own copy on ${new Date(evictedAt * 1000).toLocaleDateString()}. Steam keeps this image until you remove it.`,
  );
  // Only the flagged role offers a review, named for its role.
  const offers = [...document.body.querySelectorAll("button")].filter(
    (button) => button.textContent === "Review removing this image",
  );
  expect(offers).toHaveLength(1);
  expect(offers[0]?.getAttribute("aria-label")).toBe("Review removing this image: portrait cover");
  await act(async () => offers[0]?.click());
  expect(preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: { kind: "remove_owned_role", role: "portrait_cover" } }),
    4,
  );
  expect(document.body.textContent).toContain(
    "Only this image is removed, and only if Portcove added it and it has not changed since.",
  );
  // A review already removing this role does not offer it again.
  expect(
    [...document.body.querySelectorAll("button")].some(
      (button) => button.textContent === "Review removing this image",
    ),
  ).toBe(false);
  const remove = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Remove portrait cover from Steam",
  );
  expect(remove?.dataset.variant).toBe("destructive");
  await click("Remove portrait cover from Steam");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operation: removal.operation }),
    "single-role-plan",
    4,
  );
  expect(document.body.textContent).toContain("Portrait cover: Removed");
});

it("never presents forgetting changed art as a removal", async () => {
  vi.spyOn(desktopApi, "previewSteamArtwork").mockResolvedValue({
    ...artworkReview,
    operation: { kind: "remove_owned_role", role: "portrait_cover" },
    roles: [
      {
        ...artworkReview.roles[0]!,
        action: "preserve_modified",
        forget_ownership: true,
        destination_path: null,
        proposed_sha256: null,
      },
    ],
    writes_required: true,
  });
  vi.spyOn(desktopApi, "applySteamArtwork").mockResolvedValue({
    plan_sha256: artworkReview.plan_sha256,
    roles: [
      {
        ...artworkReview.roles[0]!,
        action: "preserve_modified",
        forget_ownership: true,
      },
    ],
    backup_paths: [],
    wrote: true,
  });
  await root.rerender(<SteamEntryDialog port={port} generation={4} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  const load = vi.spyOn(desktopApi, "previewSteamArtwork");
  await click("Review artwork removal");
  expect(load).toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "Portcove no longer recognizes this image in Steam, so nothing is removed.",
  );
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Stop tracking this image",
  );
  expect(button?.dataset.variant).toBe("primary");
  expect(document.body.textContent).toContain(
    "No Steam file changes. Portcove only stops tracking this image.",
  );
  expect(document.body.textContent).not.toContain("Only this image is removed");
  await click("Stop tracking this image");
  expect(document.body.textContent).toContain(
    "Nothing was removed. Portcove no longer tracks this image.",
  );
});

it("states single-role and all-roles outcomes when nothing is removed", async () => {
  const single = (action: SteamArtworkReview["roles"][number]["action"], writes: boolean) => ({
    ...artworkReview,
    operation: { kind: "remove_owned_role" as const, role: "portrait_cover" as const },
    roles: [{ ...artworkReview.roles[0]!, action, forget_ownership: writes }],
    writes_required: writes,
  });
  const preview = vi
    .spyOn(desktopApi, "previewSteamArtwork")
    .mockResolvedValueOnce(single("absent", true))
    .mockResolvedValueOnce(single("absent", false))
    .mockResolvedValueOnce({
      ...artworkReview,
      operation: { kind: "remove_owned" },
      roles: artworkReview.roles.map((role) => ({
        ...role,
        action: "preserve_modified" as const,
        forget_ownership: true,
      })),
    });
  vi.spyOn(desktopApi, "applySteamArtwork").mockResolvedValue({
    plan_sha256: artworkReview.plan_sha256,
    roles: artworkReview.roles.map((role) => ({
      ...role,
      action: "preserve_modified" as const,
      forget_ownership: true,
    })),
    backup_paths: [],
    wrote: true,
  });
  await root.rerender(<SteamEntryDialog port={port} generation={4} installed close={vi.fn()} />);
  await input("Steam installation folder", "C:\\Steam");
  await input("Steam profile ID", "12345");
  await click("Review artwork removal");
  expect(document.body.textContent).toContain(
    "This image is no longer in Steam, so nothing is removed.",
  );
  await click("Check again");
  expect(document.body.textContent).toContain(
    "There is no Portcove image to remove for the portrait cover in this Steam profile.",
  );
  await click("Check again");
  // All roles changed outside Portcove: the button only stops tracking.
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Stop tracking changed artwork",
  );
  expect(button?.dataset.variant).toBe("primary");
  await click("Stop tracking changed artwork");
  expect(document.body.textContent).toContain(
    "Nothing was removed. Portcove no longer tracks artwork that was changed or deleted outside Portcove.",
  );
  expect(preview).toHaveBeenCalledTimes(3);
});

it.each([
  ["single", "dark"],
  ["single", "light"],
  ["batch", "dark"],
  ["batch", "light"],
  ["artwork", "dark"],
  ["artwork", "light"],
] as const)(
  "keeps exact RTL Steam paths readable and actionable in %s / %s",
  async (flow, theme) => {
    const previous = {
      dir: document.documentElement.getAttribute("dir"),
      theme: document.documentElement.dataset.theme,
      width: innerWidth,
      height: innerHeight,
    };
    const unc = String.raw`\\مخدم\ألعاب\Steam`;
    const extended =
      String.raw`\\?\C:\SteamLibrary\Long` + "ExactFolder".repeat(8) + String.raw`\Steam`;
    const shortcuts = unc + String.raw`\userdata\12345\config\shortcuts.vdf`;
    const backup = extended + String.raw`\userdata\12345\config\shortcuts.vdf.portcove-backup`;
    const library = extended + String.raw`\Portcove Library`;
    const cli = extended + String.raw`\Portcove\portcove.exe`;
    const grid = unc + String.raw`\userdata\12345\config\grid`;
    expect(unc.split("\\")).toEqual(["", "", "مخدم", "ألعاب", "Steam"]);
    expect(extended.split("\\").slice(0, 5)).toEqual(["", "", "?", "C:", "SteamLibrary"]);
    expect(extended.slice(0, 7)).toBe("\\\\?\\C:\\");
    const second = { ...port, id: "another-port", name: "Another Port" };
    const selectedReview = {
      ...review,
      steam_root: unc,
      shortcuts_path: shortcuts,
      library_root: library,
      cli_path: cli,
    };
    const selectedBatch = {
      ...batchReviewFor(second),
      steam_root: unc,
      shortcuts_path: shortcuts,
      library_root: library,
      cli_path: cli,
    };
    const selectedArtwork = { ...artworkReview, steam_root: unc, grid_path: grid };
    const discover = vi
      .spyOn(desktopApi, "discoverSteamClientRoots")
      .mockResolvedValue([unc, extended]);
    const profiles = vi.spyOn(desktopApi, "listSteamProfiles").mockResolvedValue(["12345"]);
    const singlePreview = vi
      .spyOn(desktopApi, "previewSteamEntry")
      .mockResolvedValue(selectedReview);
    const batchPreview = vi
      .spyOn(desktopApi, "previewSteamBatchAdd")
      .mockResolvedValue(selectedBatch);
    const artworkPreview = vi
      .spyOn(desktopApi, "previewSteamArtwork")
      .mockResolvedValue(selectedArtwork);
    const applied = {
      plan_sha256: review.plan_sha256,
      shortcuts_path: shortcuts,
      backup_path: backup,
      changes: review.changes,
      wrote: true,
      artwork: [],
    };
    const singleApply = vi.spyOn(desktopApi, "applySteamEntry").mockResolvedValue(applied);
    const batchApply = vi.spyOn(desktopApi, "applySteamBatchAdd").mockResolvedValue({
      ...applied,
      plan_sha256: selectedBatch.writer_plan_sha256,
      changes: selectedBatch.changes,
    });
    const artworkApply = vi.spyOn(desktopApi, "applySteamArtwork").mockResolvedValue({
      plan_sha256: selectedArtwork.plan_sha256,
      roles: selectedArtwork.roles,
      backup_paths: [backup],
      wrote: true,
    });
    const observe = async (stage: string, target: HTMLElement) => {
      target.scrollIntoView({ block: "center" });
      await document.fonts.ready;
      const paths = [...target.querySelectorAll<HTMLElement>("input, bdi, code, dd")].map(
        (element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const glyphs: { index: number; x: number; y: number; width: number; height: number }[] =
            [];
          const text = element.firstChild;
          if (text?.nodeType === Node.TEXT_NODE) {
            for (let index = 0; index < Math.min(8, text.textContent?.length ?? 0); index++) {
              const range = document.createRange();
              range.setStart(text, index);
              range.setEnd(text, index + 1);
              const rect = range.getBoundingClientRect();
              glyphs.push({ index, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            }
          }
          return {
            tag: element.localName,
            value: element instanceof HTMLInputElement ? element.value : element.textContent,
            direction: style.direction,
            unicodeBidi: style.unicodeBidi,
            wordBreak: style.wordBreak,
            overflowWrap: style.overflowWrap,
            whiteSpace: style.whiteSpace,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            glyphs,
          };
        },
      );
      console.info(
        "Steam exact-path rendering observation: " +
          JSON.stringify({
            flow,
            theme,
            stage,
            viewport: { width: innerWidth, height: innerHeight },
            documentDirection: getComputedStyle(document.documentElement).direction,
            paths,
          }),
      );
      const opaquePaths = paths.filter((path) => path.value?.startsWith("\\\\"));
      expect(opaquePaths).toHaveLength(
        stage === "discovered" ? 2 : flow === "artwork" ? 1 : stage === "reviewed" ? 3 : 2,
      );
      for (const path of opaquePaths) expect(path.direction).toBe("ltr");
      for (const path of opaquePaths.filter((path) => path.tag !== "input")) {
        expect(path.wordBreak).toBe("break-all");
        const isExtended = path.value.startsWith("\\\\?\\");
        expect(isExtended).toBe(path.value.startsWith(extended));
        const prefix = path.glyphs.slice(0, isExtended ? 7 : 3);
        expect(prefix).toHaveLength(isExtended ? 7 : 3);
        for (const glyph of prefix.slice(1)) expect(glyph.y).toBe(prefix[0]!.y);
        // Arabic server names keep their natural shaping and visual run order.
        const orderedPrefix = prefix.slice(0, isExtended ? 7 : 2);
        for (const [index, glyph] of orderedPrefix.slice(1).entries())
          expect(glyph.x).toBeGreaterThan(orderedPrefix[index]!.x);
      }
      const bounds = target.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      await captureParityState(`steam-path-direction-${flow}-${stage}`);
    };
    try {
      await page.viewport(430, 896);
      document.documentElement.dir = "rtl";
      document.documentElement.dataset.theme = theme;
      await root.rerender(
        flow === "batch" ? (
          <SteamBatchEntryDialog ports={[port, second]} generation={7} close={vi.fn()} />
        ) : (
          <SteamEntryDialog port={port} generation={7} installed close={vi.fn()} />
        ),
      );
      if (flow === "batch") {
        await page.getByRole("checkbox", { name: port.name }).click();
        await page.getByRole("checkbox", { name: second.name }).click();
      }
      await click("Find Steam installations");
      expect(discover).toHaveBeenCalledExactlyOnceWith(7);
      const installations = document.querySelector<HTMLElement>(
        '[aria-label="Local Steam installations"]',
      )!;
      await observe("discovered", installations);
      await click(extended);
      await expect.element(page.getByLabelText("Steam installation folder")).toHaveValue(extended);
      await click(unc);
      await expect.element(page.getByLabelText("Steam installation folder")).toHaveValue(unc);
      expect(
        getComputedStyle(page.getByLabelText("Steam installation folder").element()).direction,
      ).toBe("ltr");
      await expect.element(page.getByLabelText("Steam profile ID")).toHaveValue("");
      expect(profiles).not.toHaveBeenCalled();
      await click("Find local profiles");
      expect(profiles).toHaveBeenCalledExactlyOnceWith(unc, 7);
      await click("12345");
      await click(
        flow === "batch"
          ? "Review selected shortcuts"
          : flow === "artwork"
            ? "Review artwork update"
            : "Review shortcut setup",
      );
      const reviewed = document.querySelector<HTMLElement>(
        `[aria-label="${flow === "artwork" ? "Reviewed Steam artwork" : "Reviewed Steam shortcut change"}"]`,
      )!;
      const details = reviewed.querySelector("details")!;
      details.open = true;
      for (const path of flow === "artwork" ? [grid] : [shortcuts, library, cli])
        expect(details.textContent).toContain(path);
      expect(singleApply).not.toHaveBeenCalled();
      expect(batchApply).not.toHaveBeenCalled();
      expect(artworkApply).not.toHaveBeenCalled();
      await observe("reviewed", details);
      const previews = {
        batch: {
          mock: batchPreview,
          args: [
            {
              portIds: [port.id, second.id],
              steamRoot: unc,
              steamUserId: "12345",
              includeArtwork: true,
            },
            7,
          ],
        },
        artwork: {
          mock: artworkPreview,
          args: [
            {
              portId: port.id,
              steamRoot: unc,
              steamUserId: "12345",
              operation: { kind: "update", replace_existing: false },
            },
            7,
          ],
        },
        single: {
          mock: singlePreview,
          args: [port.id, unc, "12345", "add_or_repair", true, 7],
        },
      };
      const preview = previews[flow];
      expect(preview.mock.mock.calls).toEqual([preview.args]);
      for (const other of [singlePreview, batchPreview, artworkPreview].filter(
        (mock) => mock !== preview.mock,
      ))
        expect(other).not.toHaveBeenCalled();
      await click(
        flow === "batch"
          ? "Add or repair selected shortcuts"
          : flow === "artwork"
            ? "Update Steam artwork"
            : "Add or repair shortcut",
      );
      const result = document.querySelector<HTMLElement>(
        `[aria-label="${flow === "artwork" ? "Steam artwork result" : flow === "batch" ? "Steam batch result" : "Steam shortcut result"}"]`,
      )!;
      const applications = {
        batch: {
          mock: batchApply,
          args: [
            {
              portIds: [port.id, second.id],
              steamRoot: unc,
              steamUserId: "12345",
              includeArtwork: true,
            },
            selectedBatch.review_sha256,
            selectedBatch.artwork_review_sha256,
            7,
          ],
        },
        artwork: {
          mock: artworkApply,
          args: [
            {
              portId: port.id,
              steamRoot: unc,
              steamUserId: "12345",
              operation: selectedArtwork.operation,
            },
            selectedArtwork.plan_sha256,
            7,
          ],
        },
        single: {
          mock: singleApply,
          args: [
            port.id,
            unc,
            "12345",
            "add_or_repair",
            true,
            selectedReview.plan_sha256,
            selectedReview.artwork_review_sha256,
            7,
          ],
        },
      };
      const application = applications[flow];
      expect(application.mock.mock.calls).toEqual([application.args]);
      for (const other of [singleApply, batchApply, artworkApply].filter(
        (mock) => mock !== application.mock,
      ))
        expect(other).not.toHaveBeenCalled();
      for (const path of flow === "artwork" ? [backup] : [backup, shortcuts])
        expect(result.textContent).toContain(path);
      await observe("result", result);
    } finally {
      if (previous.dir === null) document.documentElement.removeAttribute("dir");
      else document.documentElement.setAttribute("dir", previous.dir);
      if (previous.theme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previous.theme;
      await page.viewport(previous.width, previous.height);
    }
  },
);
