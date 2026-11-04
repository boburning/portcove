import { act } from "react";
import axe from "axe-core";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import { failureReport, portStatus, sourceProfile } from "../test-fixtures";
import type { SourceRecord, SourceReuseReview } from "../types";
import {
  SetupReviewSelectionProvider,
  useSetupReviewSelection,
} from "../features/game-file-discovery/setup-review-selection";
import { RegisteredSourceSetup } from "./RegisteredSourceSetup";
import type { Perform } from "../features/operations/use-operation-state";

vi.mock("../file-picker", { spy: true });

const source: SourceRecord = {
  profile_id: "majoras-mask",
  path: "D:/original.z64",
  sha256: "a".repeat(64),
  size: 64,
  storage_sha256: "a".repeat(64),
  storage_size: 64,
  updated_at: 1,
};
const reference = { profile_id: source.profile_id, reference_sha256: "b".repeat(64) };
const makeReview = (): SourceReuseReview => ({
  registration: source,
  reference,
  inspection: {
    schema_version: 1,
    profile_id: source.profile_id,
    health: "current",
    state_code: "recognized_exact",
    summary: "Observed controlled edition",
    next_action: "Review each integration",
    registered: source,
    applications: [],
    evidence: [],
    legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
  },
  applications: [
    {
      port_id: "2ship2harkinian",
      port_name: "2Ship",
      role: "game",
      contract_id: "2ship-source",
      compatibility: "listed_identity",
      can_review_setup: true,
      summary: "The edition is listed, with informational admission.",
      additional_checks: ["Review the integration's remaining requirements."],
    },
    {
      port_id: "zelda64-recomp",
      port_name: "Zelda64",
      role: "game",
      contract_id: "zelda-source",
      compatibility: "incompatible",
      can_review_setup: false,
      summary: "This edition is not listed. Choose USA 1.0.",
      additional_checks: [],
    },
  ],
});
const statuses = new Map(
  ["2ship2harkinian", "zelda64-recomp"].map((id) => [
    id,
    {
      ...portStatus(),
      port_id: id,
      port_actions: [
        {
          action: "install" as const,
          availability: "allowed" as const,
          reason: "available" as const,
        },
      ],
    },
  ]),
);
const element = document.createElement("div");
document.body.append(element);
const root = createRoot(element);
const open = vi.fn();
const changed = vi.fn(async () => undefined);
const perform: Perform = async (_name, task) => task();
let selection: ReturnType<typeof useSetupReviewSelection>;
function Fixture({
  generation = 3,
  current = true,
  registration = source,
  profileLabel,
}: {
  generation?: number;
  current?: boolean;
  registration?: SourceRecord;
  profileLabel?: string;
}) {
  selection = useSetupReviewSelection();
  return (
    <RegisteredSourceSetup
      sources={[registration]}
      profiles={[
        {
          ...sourceProfile(),
          id: source.profile_id,
          ...(profileLabel ? { label: profileLabel } : {}),
        },
      ]}
      statuses={statuses}
      generation={generation}
      current={current}
      perform={perform}
      onChanged={changed}
      onOpenPort={open}
    />
  );
}
const render = (generation = 3, current = true, registration = source, profileLabel?: string) =>
  root.render(
    <SetupReviewSelectionProvider>
      <h1>Add games</h1>
      <Fixture
        generation={generation}
        current={current}
        registration={registration}
        {...(profileLabel ? { profileLabel } : {})}
      />
    </SetupReviewSelectionProvider>,
  );
const button = (text: string) =>
  [...element.querySelectorAll("button")].find((item) => item.textContent === text)!;
async function select() {
  await act(async () => {
    const input = element.querySelector("select")!;
    input.value = source.profile_id;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  open.mockClear();
  changed.mockClear();
});
afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
});

it("uses Core's per-integration result and carries the checked reference without another picker", async () => {
  const check = vi.spyOn(desktopApi, "reviewSourceReuse").mockResolvedValue(makeReview());
  const pick = vi.spyOn(picker, "pickSourcePath").mockResolvedValue(null);
  await act(async () => render());
  await select();
  await act(async () => button("Check saved game files").click());
  const accessibility = await axe.run(element, {
    runOnly: { type: "rule", values: ["heading-order"] },
  });
  expect(accessibility.violations).toEqual([]);
  expect(check).toHaveBeenCalledWith(source.profile_id, 3);
  expect(element.textContent).toContain("Choose USA 1.0");
  expect(button("Review Zelda64 setup using these files")).toBeUndefined();
  await act(async () => button("Review 2Ship setup using these files").click());
  expect(selection.pendingReview).toEqual({
    portId: "2ship2harkinian",
    channel: "stable",
    sourceReference: reference,
  });
  expect(open).toHaveBeenCalledWith("2ship2harkinian", "add-games:saved-source");
  expect(pick).not.toHaveBeenCalled();
});

it("ignores a completed inspection from the outgoing library generation", async () => {
  let resolve!: (review: SourceReuseReview) => void;
  vi.spyOn(desktopApi, "reviewSourceReuse").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () => render());
  await select();
  await act(async () => button("Check saved game files").click());
  await act(async () => render(4));
  await act(async () => resolve(makeReview()));
  expect(button("Review 2Ship setup using these files")).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});

it("focuses the committed review when an animation callback runs before React commits", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(performance.now());
    return 1;
  });
  vi.spyOn(desktopApi, "reviewSourceReuse").mockResolvedValue(makeReview());
  await act(async () => render());
  await select();
  await act(async () => button("Check saved game files").click());
  expect(document.activeElement).toBe(element.querySelector("h3"));
});

it("does not refocus a cached review when the library becomes current again", async () => {
  vi.spyOn(desktopApi, "reviewSourceReuse").mockResolvedValue(makeReview());
  await act(async () => render());
  await select();
  await act(async () => button("Check saved game files").click());
  expect(document.activeElement).toBe(element.querySelector("h3"));
  const input = element.querySelector("select")!;
  input.focus();
  await act(async () => render(3, false));
  await act(async () => render());
  expect(element.querySelector("h3")).not.toBeNull();
  expect(document.activeElement).toBe(input);
});

it("repairs moved identical files through the existing baseline-bound relink, never registration", async () => {
  const replacement = { ...source, path: "E:/moved.z64", updated_at: 2 };
  vi.spyOn(picker, "pickSourcePath").mockResolvedValue(replacement.path);
  const plan = vi
    .spyOn(desktopApi, "planSourceRelink")
    .mockResolvedValue({ original: source, replacement, preview_sha256: "c".repeat(64) });
  const apply = vi.spyOn(desktopApi, "relinkSource").mockResolvedValue(replacement);
  const add = vi.spyOn(desktopApi, "addSource");
  await act(async () => render());
  await select();
  await act(async () => button("Repair moved file location").click());
  expect(plan).toHaveBeenCalledWith(source.profile_id, replacement.path, 3);
  expect(apply).toHaveBeenCalledWith(source.profile_id, replacement.path, "c".repeat(64), 3);
  expect(add).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(element.textContent).toContain("saved original-file identity is unchanged");
});

it("refuses a stale repair baseline and preserves substituted-input failure without applying", async () => {
  vi.spyOn(picker, "pickSourcePath").mockResolvedValue("E:/replacement.z64");
  const plan = vi.spyOn(desktopApi, "planSourceRelink").mockResolvedValue({
    original: { ...source, sha256: "d".repeat(64) },
    replacement: source,
    preview_sha256: "c".repeat(64),
  });
  const apply = vi.spyOn(desktopApi, "relinkSource");
  await act(async () => render());
  await select();
  await act(async () => button("Repair moved file location").click());
  expect(element.textContent).toContain("registration changed");
  expect(apply).not.toHaveBeenCalled();
  plan.mockRejectedValueOnce(failureReport());
  await act(async () => button("Repair moved file location").click());
  expect(element.textContent).toContain(failureReport().presentation.summary);
  expect(element.textContent).toContain("Location repair needs the same original content");
  expect(element.textContent).toContain("check different files separately");
  expect(apply).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("keeps ordinary source-check errors separate from moved-location guidance", async () => {
  vi.spyOn(desktopApi, "reviewSourceReuse").mockRejectedValue(failureReport());
  await act(async () => render());
  await select();
  await act(async () => button("Check saved game files").click());
  expect(element.textContent).toContain(failureReport().presentation.summary);
  expect(element.textContent).not.toContain("Location repair needs");
  expect(open).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("keeps a refresh failure separate after the moved location was repaired", async () => {
  const replacement = { ...source, path: "E:/moved.z64", updated_at: 2 };
  vi.spyOn(picker, "pickSourcePath").mockResolvedValue(replacement.path);
  vi.spyOn(desktopApi, "planSourceRelink").mockResolvedValue({
    original: source,
    replacement,
    preview_sha256: "c".repeat(64),
  });
  const apply = vi.spyOn(desktopApi, "relinkSource").mockResolvedValue(replacement);
  changed.mockRejectedValueOnce(new Error("Workspace refresh failed"));
  await act(async () => render());
  await select();
  await act(async () => button("Repair moved file location").click());
  expect(apply).toHaveBeenCalledTimes(1);
  expect(element.textContent).toContain("Location repaired");
  expect(element.textContent).toContain("Workspace refresh failed");
  expect(element.textContent).not.toContain("Location repair needs");
  expect(changed).toHaveBeenCalledTimes(1);
});

for (const label of [
  "The Legend of Zelda: Majora's Mask source",
  "Original_game_files_".repeat(12),
]) {
  it(`contains the saved path and checked choices at narrow widths: ${label.slice(0, 45)}`, async () => {
    const registration = {
      ...source,
      path:
        "E:/owned-evidence/retained-source-session/" +
        "long-folder-name/".repeat(8) +
        "original-USA-1.0.zip",
    };
    const review = makeReview();
    review.registration = registration;
    review.inspection.registered = registration;
    vi.spyOn(desktopApi, "reviewSourceReuse").mockResolvedValue(review);
    try {
      await page.viewport(320, 208);
      await act(async () => render(3, true, registration, label));
      await select();
      await act(async () => button("Check saved game files").click());
      const region = element.querySelector<HTMLElement>('[aria-label="Reuse saved game files"]')!;
      for (const width of [320, 240]) {
        await page.viewport(width, 208);
        await expect.poll(() => element.scrollWidth - element.clientWidth).toBeLessThanOrEqual(1);
        const bounds = element.getBoundingClientRect();
        for (const control of region.querySelectorAll("select, button, h3, article")) {
          const rectangle = control.getBoundingClientRect();
          expect(rectangle.left).toBeGreaterThanOrEqual(bounds.left);
          expect(rectangle.right).toBeLessThanOrEqual(bounds.right + 1);
        }
        expect(region.textContent).toContain("This edition is not listed. Choose USA 1.0.");
      }
    } finally {
      await page.viewport(1280, 800);
    }
  });
}
