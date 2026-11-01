import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import { portStatus, sourceProfile } from "../test-fixtures";
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
function Fixture({ generation = 3 }: { generation?: number }) {
  selection = useSetupReviewSelection();
  return (
    <RegisteredSourceSetup
      sources={[source]}
      profiles={[{ ...sourceProfile(), id: source.profile_id }]}
      statuses={statuses}
      generation={generation}
      current={true}
      perform={perform}
      onChanged={changed}
      onOpenPort={open}
    />
  );
}
const render = (generation = 3) =>
  root.render(
    <SetupReviewSelectionProvider>
      <Fixture generation={generation} />
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
  plan.mockRejectedValueOnce(
    new Error(
      "Relink requires the same original bytes. Choose the moved original, not another edition.",
    ),
  );
  await act(async () => button("Repair moved file location").click());
  expect(element.textContent).toContain("not another edition");
  expect(apply).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});
