// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import type { PreparationPlan } from "../types";
import { PreparationControl, type RunPreparation } from "./Preparation";

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
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
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
  const button = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

it.each(["remove", "replace"])(
  "restores selected requirements focus when successful preparation %s changes its opener",
  async (completion) => {
    vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
    function SelectedRequirements() {
      const [pendingSetup, setPendingSetup] = useState(true);
      const [installId, setInstallId] = useState("original");
      const summary = useRef<HTMLElement>(null);
      return (
        <>
          <button>Settings</button>
          <section data-detail-workspace>
            <details open>
              <summary ref={summary}>Game-file requirements and setup</summary>
              {pendingSetup && (
                <PreparationControl
                  key={installId}
                  portId="sample"
                  generation={7}
                  disabled={false}
                  focusFallback={() => summary.current}
                  run={async () => {
                    if (completion === "remove") setPendingSetup(false);
                    else setInstallId("prepared");
                    return plan.inputs.install;
                  }}
                />
              )}
            </details>
            <button>Play</button>
          </section>
        </>
      );
    }
    await act(async () => root.render(<SelectedRequirements />));
    container.querySelector("button")?.focus();
    await click("Review game preparation");
    await click("Prepare game data");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    if (completion === "remove")
      expect(document.body.textContent).not.toContain("Review game preparation");
    expect(document.activeElement).toBe(container.querySelector("summary"));
  },
);

it("does not restore stale preparation focus after its owning workspace disappears", async () => {
  vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  function SelectedRequirements() {
    const summary = useRef<HTMLElement>(null);
    return (
      <section>
        <details open>
          <summary ref={summary}>Game-file requirements and setup</summary>
          <PreparationControl
            portId="sample"
            generation={7}
            disabled={false}
            run={vi.fn()}
            focusFallback={() => summary.current}
          />
        </details>
      </section>
    );
  }
  await act(async () => root.render(<SelectedRequirements />));
  await click("Review game preparation");
  await act(async () => root.render(<button>Other selected game</button>));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it.each(["other:7", "sample:8"])(
  "preserves deliberate navigation focus after the requirements owner changes to %s",
  async (nextOwner) => {
    vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
    function RequirementsOwner({ owner }: { owner: string }) {
      const summary = useRef<HTMLElement>(null);
      return (
        <details open>
          <summary ref={summary}>Game-file requirements and setup</summary>
          <PreparationControl
            key={owner}
            portId={owner.split(":")[0]}
            generation={Number(owner.split(":")[1])}
            disabled={false}
            run={vi.fn()}
            focusFallback={() => summary.current}
          />
        </details>
      );
    }
    function SelectedRequirements({ owner }: { owner: string }) {
      return (
        <>
          <button key={`navigation:${owner}`} autoFocus={owner !== "sample:7"}>
            Choose another game
          </button>
          <RequirementsOwner key={owner} owner={owner} />
        </>
      );
    }
    await act(async () => root.render(<SelectedRequirements owner="sample:7" />));
    await click("Review game preparation");
    await act(async () => {
      root.render(<SelectedRequirements owner={nextOwner} />);
    });
    const navigation = container.querySelector("button");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.outerHTML).toContain("Choose another game");
    expect(document.activeElement).toBe(navigation);
  },
);

it("uses the selected requirements fallback when the surviving opener becomes disabled", async () => {
  vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  function SelectedRequirements() {
    const [disabled, setDisabled] = useState(false);
    const summary = useRef<HTMLElement>(null);
    return (
      <details open>
        <summary ref={summary}>Game-file requirements and setup</summary>
        <PreparationControl
          portId="sample"
          generation={7}
          disabled={disabled}
          focusFallback={() => summary.current}
          run={async () => {
            setDisabled(true);
            return undefined;
          }}
        />
      </details>
    );
  }
  await act(async () => root.render(<SelectedRequirements />));
  await click("Review game preparation");
  await click("Prepare game data");
  expect(container.querySelector("button")?.disabled).toBe(true);
  expect(document.activeElement).toBe(container.querySelector("summary"));
});

it("reviews without executing and binds explicit confirmation to the returned plan", async () => {
  const review = vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  const run = vi.fn().mockResolvedValue(plan.inputs.install);
  await act(async () =>
    root.render(<PreparationControl portId="sample" generation={7} disabled={false} run={run} />),
  );
  await click("Review game preparation");
  expect(review).toHaveBeenCalledWith("sample", 7);
  expect(run).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.querySelector('[role="dialog"] .preparation-plan')).not.toBeNull();
  expect(document.body.textContent).toContain("E:/owned.iso");
  expect(document.body.textContent).toContain("Prepare game data");
  expect(document.body.textContent).toContain("Selected game files");
  expect(document.body.textContent).toContain("of free space before the game generates output");
  expect(document.body.textContent).toContain("previous version remains available for rollback");
  expect(document.body.textContent).toContain("unfinished setup files kept for review");
  expect(document.body.textContent).toContain("Do not launch the game from that window");
  expect(document.activeElement?.textContent).toBe("Prepare game data");
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("Review game preparation");
  await click("Review game preparation");
  await click("Prepare game data");
  expect(run).toHaveBeenCalledWith("reviewed-plan", expect.any(Function));
  expect(document.body.textContent).toContain("Game data is prepared");
});

it("keeps the reviewed preparation and cancellation control available while setup starts", async () => {
  vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  let finish!: (value: typeof plan.inputs.install) => void;
  const run = vi.fn<RunPreparation>((_expectedPlan, onEvent) => {
    onEvent({
      schema_version: 2,
      operation_id: "preparation-1",
      parent_operation_id: null,
      target: null,
      sequence: 0,
      timestamp_ms: 1,
      operation: "prepare",
      type: "started",
    });
    return new Promise<typeof plan.inputs.install>((resolve) => {
      finish = resolve;
    });
  });
  await act(async () =>
    root.render(<PreparationControl portId="sample" generation={7} disabled={false} run={run} />),
  );
  await click("Review game preparation");
  await click("Prepare game data");
  expect(document.body.textContent).toContain("Cancel preparation");
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finish(plan.inputs.install));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
});

it("requires a fresh review after an execution error and reports no success", async () => {
  vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  const run = vi.fn().mockRejectedValue(new Error("Inputs changed"));
  await act(async () =>
    root.render(<PreparationControl portId="sample" generation={7} disabled={false} run={run} />),
  );
  await click("Review game preparation");
  await click("Prepare game data");
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Inputs changed");
  expect(document.body.textContent).not.toContain("Game data is prepared");
  expect(document.activeElement?.textContent).toBe("Review game preparation");
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toContain(
    "Review game preparation",
  );
});

it.each(["cancelled", "refused"])(
  "restores the available opener after preparation is %s",
  async (outcome) => {
    vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
    const run =
      outcome === "cancelled"
        ? vi.fn().mockRejectedValue({ code: "cancelled" })
        : vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(<PreparationControl portId="sample" generation={7} disabled={false} run={run} />),
    );
    await click("Review game preparation");
    await click("Prepare game data");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Review game preparation");
    expect(document.body.textContent).not.toContain("Game data is prepared");
    expect(document.body.textContent).toContain(
      outcome === "cancelled" ? "Setup cancelled" : "Preparation did not complete",
    );
  },
);

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
  expect(document.body.textContent).not.toContain("E:/owned.iso");
  expect(run).not.toHaveBeenCalled();
});
