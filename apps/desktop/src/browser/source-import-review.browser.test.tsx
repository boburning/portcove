import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { SourceImportReview, sourceImportModePresentation } from "../components/SourceDiscovery";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import type { SourceImportMode, SourceImportPlan } from "../types";
import "../styles/index.css";

vi.mock("../api", () => ({ desktopApi: {} }));
const containsText = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const apply = vi.fn(async () => {});
const cancel = vi.fn();
const profile = {
  id: "owned",
  label: "Owned game or BIOS file requirement with a long reviewed profile label",
};
const source = {
  profile_id: profile.id,
  path: "D:/Player originals/Long folder with spaces and Unicode 日本語/original game files.iso",
  sha256: "a".repeat(64),
  size: 64,
  storage_sha256: "a".repeat(64),
  storage_size: 64,
  updated_at: 1,
};
function reviewedPlan(mode: SourceImportMode): SourceImportPlan {
  return {
    schema_version: 1,
    profile_id: profile.id,
    mode,
    source,
    admission_mode: "structural_checks",
    destination:
      mode === "use_current_location"
        ? source.path
        : "D:/Portcove library/source-inbox/owned/Existing checked copy with spaces/game.iso",
    destination_exists: mode !== "copy",
    existing_registration: { ...source, path: "D:/Previously saved location/game.iso" },
    reuse_existing: mode !== "copy",
    required_bytes: mode === "copy" ? 64 : 0,
    source_guard_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
  };
}
function Fixture({ plan }: { plan: SourceImportPlan }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <main>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        Review source files
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          finalFocus={trigger}
          className="max-h-[calc(100dvh-var(--space-8))] w-[min(760px,90vw)] max-w-none overflow-y-auto p-8 sm:max-w-none"
        >
          <DialogTitle>Review selected source files</DialogTitle>
          <DialogDescription>
            This renderer fixture demonstrates reviewed facts and callbacks only.
          </DialogDescription>
          <SourceImportReview
            plan={plan}
            profiles={[profile]}
            busy={false}
            onCancel={() => {
              cancel();
              setOpen(false);
            }}
            onApply={async () => {
              await apply();
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  apply.mockClear();
  cancel.mockClear();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
});
it.each(["light", "dark"])(
  "shows authoritative review distinctions and neutral cancel in %s",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(960, 640);
    for (const mode of ["copy", "move", "use_current_location"] as const) {
      const plan = reviewedPlan(mode);
      const original = JSON.stringify(plan);
      const previousApplications = apply.mock.calls.length;
      flushSync(() =>
        root.render(
          <DirectionProvider direction="ltr">
            <Fixture plan={plan} />
          </DirectionProvider>,
        ),
      );
      const trigger = page.getByRole("button", { name: "Review source files", exact: true });
      await userEvent.click(trigger);
      const review = page.getByRole("region", { name: "Source import review" });
      await expect.element(review).toMatchTextContent(containsText(profile.label));
      await expect
        .element(review)
        .toMatchTextContent(
          containsText("Structural admission alone does not establish an exact edition"),
        );
      await expect.element(review).toMatchTextContent(containsText(source.path));
      await expect.element(review).toMatchTextContent(containsText(plan.destination));
      await expect.element(review).toMatchTextContent(containsText("Currently saved location"));
      await expect
        .element(review)
        .toMatchTextContent(
          containsText(`Additional file data planned: ${mode === "copy" ? "64 B" : "0 B"}`),
        );
      const present =
        mode === "move"
          ? ["existing Portcove copy will be checked and reused", "original is deleted only after"]
          : mode === "use_current_location"
            ? ["Keep this location available"]
            : [];
      const absent = mode === "use_current_location" ? ["existing Portcove copy"] : [];
      for (const message of present)
        await expect.element(review).toMatchTextContent(containsText(message));
      for (const message of absent)
        await expect.element(review).not.toMatchTextContent(containsText(message));

      const element = document.querySelector<HTMLElement>('[aria-label="Source import review"]')!;
      for (const code of element.querySelectorAll("code")) {
        const box = code.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
        expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
      }
      expect(apply).toHaveBeenCalledTimes(previousApplications);
      await userEvent.click(page.getByRole("button", { name: "Cancel review", exact: true }));
      await expect.element(trigger).toHaveFocus();
      expect(apply).toHaveBeenCalledTimes(previousApplications);
      expect(JSON.stringify(plan)).toBe(original);
      await userEvent.click(trigger);
      await userEvent.click(
        page.getByRole("button", { name: sourceImportModePresentation(mode).label, exact: true }),
      );
      await expect.element(trigger).toHaveFocus();
      expect(JSON.stringify(plan)).toBe(original);
    }
    expect(apply).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(3);
  },
);
