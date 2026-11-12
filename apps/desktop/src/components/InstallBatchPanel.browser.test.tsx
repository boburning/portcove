import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { InstallBatchRecord, InstallBatchReview } from "../types";
import { InstallBatchPanel } from "./InstallBatchPanel";

type ReviewItem = InstallBatchReview["items"][number];

/** The panel reads only the release version and digest from a plan. */
function ready(portId: string, version: string): ReviewItem {
  return {
    port_id: portId,
    plan: {
      plan_sha256: portId.padEnd(64, "0").slice(0, 64),
      plan: { release: { version } },
    } as unknown as NonNullable<ReviewItem["plan"]>,
  };
}

const ports = ["first", "second", "third"].map((id) => ({
  ...portDefinition(),
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
}));

const review: InstallBatchReview = {
  items: [
    ready("first", "1.0"),
    ready("second", "2.0"),
    { port_id: "third", hold: "Missing files" },
  ],
  capacity: {
    download_bytes: 3 * 1024 * 1024,
    volumes: [
      {
        path: "D:/Games",
        volume_identity: "D",
        required_bytes: 2 * 1024 * 1024,
        available_bytes: 1024 * 1024,
        sufficient: false,
        port_ids: ["first", "second"],
      },
    ],
  },
};

let root: RenderResult;
const text = () => document.body.textContent ?? "";
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(async () => {
  vi.spyOn(desktopApi, "unfinishedInstallBatches").mockResolvedValue([]);
  vi.spyOn(desktopApi, "planInstallBatch").mockResolvedValue(review);
  vi.spyOn(desktopApi, "startInstallBatch");
  vi.spyOn(desktopApi, "addGamesToLibrary");
  const host = document.createElement("div");
  document.body.append(host);
  root = await renderComponent(null, { container: host });
});
afterEach(async () => {
  await cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("reviews the whole selection once, with combined space, before anything changes", async () => {
  const onDone = vi.fn();
  await root.rerender(
    <InstallBatchPanel
      generation={1}
      ports={ports}
      portIds={["first", "second", "third"]}
      onDone={onDone}
    />,
  );
  await act(async () => {});
  expect(desktopApi.planInstallBatch).toHaveBeenCalledWith(["first", "second", "third"], 1);
  expect(text()).toContain("2 ready to install, 1 waiting");
  expect(text()).toContain("Waiting. Missing files");
  expect(text()).toContain("Downloads together");
  expect(text()).toContain("That isn't enough for all of them");
  expect(text()).toContain("First and Second need");
  // Reviewing changed nothing.
  expect(desktopApi.startInstallBatch).not.toHaveBeenCalled();
  await act(async () => button("Cancel").click());
  expect(onDone).toHaveBeenCalled();
  expect(desktopApi.addGamesToLibrary).not.toHaveBeenCalled();
});

it("one confirmation saves every game and installs only the ready ones", async () => {
  const batch: InstallBatchRecord = {
    format_version: 1,
    id: "batch-1",
    created_at: 1,
    updated_at: 1,
    cancel_requested: false,
    items: [
      { port_id: "first", expected_plan_sha256: "f".repeat(64), state: "queued" },
      { port_id: "second", expected_plan_sha256: "s".repeat(64), state: "queued" },
    ],
  } as unknown as InstallBatchRecord;
  vi.mocked(desktopApi.addGamesToLibrary).mockResolvedValue([]);
  vi.mocked(desktopApi.startInstallBatch).mockResolvedValue(batch);
  vi.spyOn(desktopApi, "runInstallBatch").mockResolvedValue({
    ...batch,
    items: [
      { ...batch.items[0]!, state: "ready" },
      { ...batch.items[1]!, state: "failed", detail: "Download failed" },
    ],
  });
  await root.rerender(
    <InstallBatchPanel
      generation={1}
      ports={ports}
      portIds={["first", "second", "third"]}
      onDone={() => undefined}
    />,
  );
  await act(async () => {});
  await act(async () => button("Add 3 to Library and install 2").click());
  expect(desktopApi.addGamesToLibrary).toHaveBeenCalledWith(
    [{ port_id: "third", origin: "game_file_discovery" }],
    1,
  );
  expect(desktopApi.startInstallBatch).toHaveBeenCalledWith(
    [
      { port_id: "first", expected_plan_sha256: review.items[0]!.plan!.plan_sha256 },
      { port_id: "second", expected_plan_sha256: review.items[1]!.plan!.plan_sha256 },
    ],
    1,
  );
  expect(text()).toContain("Setup batch results");
  expect(text()).toContain("First: Installed");
  expect(text()).toContain("Second: Couldn't install. Download failed");
});

it("keeps the exact English space sentences for one game and for three", async () => {
  const volume = {
    path: "D:/Games",
    volume_identity: "D",
    required_bytes: 2 * 1024 * 1024,
    available_bytes: null,
    sufficient: null,
    port_ids: ["first"],
  };
  vi.mocked(desktopApi.planInstallBatch).mockResolvedValue({
    ...review,
    capacity: {
      download_bytes: 0,
      volumes: [
        volume,
        {
          ...volume,
          volume_identity: "E",
          port_ids: ["first", "second", "third"],
          sufficient: true,
          available_bytes: 8 * 1024 * 1024,
        },
      ],
    },
  });
  await root.rerender(
    <InstallBatchPanel generation={1} ports={ports} portIds={["first"]} onDone={vi.fn()} />,
  );
  await act(async () => {});
  expect(text()).toContain(
    "First needs 2.0 MiB of temporary space on the same drive. Its free space is unknown; each game is checked before it runs.",
  );
  expect(text()).toContain(
    "First, Second and Third need 2.0 MiB of temporary space on the same drive, which has 8.0 MiB free.",
  );
});

it("reviews the selection in the current language with exact names and versions", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    await root.rerender(
      <InstallBatchPanel
        generation={1}
        ports={ports}
        portIds={["first", "second", "third"]}
        onDone={vi.fn()}
      />,
    );
    await act(async () => {});
    expect(text()).toContain("مراجعة تثبيت الألعاب المحددة");
    expect(text()).toContain("First: تثبيت 1.0");
    expect(text()).toContain("Third: قيد الانتظار. Missing files");
    expect(text()).toContain("First وSecond");
    expect(button("إلغاء")).toBeTruthy();
    expect(text()).not.toContain("Review installing selected games");
  } finally {
    await localization.changeLanguage("en");
  }
});
