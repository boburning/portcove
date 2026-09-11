// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import type { PreparationPlan } from "../types";
import { PreparationControl } from "./Preparation";

const plan: PreparationPlan = {
  format_version: 1,
  port_id: "sample",
  plan_sha256: "reviewed-plan",
  copy: { directories: [], files: [], skipped_entries: [], total_bytes: 1024 },
  inputs: {
    definition_sha256: "definition",
    host: "windows-x86-64",
    options: { target: "windows-x86-64", mode: "default" },
    conversion_tool: null,
    setup_tool: { path: "E:/sample/setup.exe", sha256: "tool", size: 512 },
    install: {
      id: "original",
      port_id: "sample",
      path: "E:/sample",
      version: "1.2",
      channel: "stable",
      installed_at: 1,
      verified: true,
      staged: false,
      artifact: { asset_name: "owned.zip", sha256: "artifact", size: 512 },
      manifest_sha256: "manifest",
      selected_executable: "game.exe",
      runtime: null,
    },
    source: {
      profile_id: "source",
      path: "E:/owned.iso",
      sha256: "source",
      size: 512,
      storage_sha256: "source",
      storage_size: 512,
      updated_at: 1,
    },
    source_inspection: {
      schema_version: 1,
      profile_id: "source",
      health: "current",
      state_code: "selected_needs_checking",
      summary: "Owned source",
      next_action: "Prepare",
      applications: [],
      evidence: [],
      legacy: {
        registration_identity_not_recorded: true,
        variant_unspecified_records: [],
      },
    },
  },
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
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("reviews without executing and binds explicit confirmation to the returned plan", async () => {
  const review = vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  const run = vi.fn().mockResolvedValue(plan.inputs.install);
  await act(async () =>
    root.render(<PreparationControl portId="sample" generation={7} disabled={false} run={run} />),
  );
  await click("Review game preparation");
  expect(review).toHaveBeenCalledWith("sample", 7);
  expect(run).not.toHaveBeenCalled();
  expect(container.textContent).toContain("E:/owned.iso");
  expect(document.activeElement?.textContent).toBe("Start new preparation");
  await click("Start new preparation");
  expect(run).toHaveBeenCalledWith("reviewed-plan", expect.any(Function));
  expect(container.textContent).toContain("Game data is prepared");
});

it("requires a fresh review after an execution error and reports no success", async () => {
  vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  const run = vi.fn().mockRejectedValue(new Error("Inputs changed"));
  await act(async () =>
    root.render(<PreparationControl portId="sample" generation={7} disabled={false} run={run} />),
  );
  await click("Review game preparation");
  await click("Start new preparation");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Inputs changed");
  expect(container.textContent).not.toContain("Game data is prepared");
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toContain(
    "Review game preparation",
  );
});

it("does not carry a late review across a library or port switch", async () => {
  let complete!: (value: PreparationPlan) => void;
  vi.spyOn(desktopApi, "planPreparation").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const run = vi.fn();
  await act(async () =>
    root.render(
      <PreparationControl key="old" portId="sample" generation={7} disabled={false} run={run} />,
    ),
  );
  await click("Review game preparation");
  await act(async () =>
    root.render(
      <PreparationControl key="new" portId="other" generation={8} disabled={false} run={run} />,
    ),
  );
  await act(async () => complete(plan));
  expect(container.textContent).not.toContain("E:/owned.iso");
  expect(run).not.toHaveBeenCalled();
});
