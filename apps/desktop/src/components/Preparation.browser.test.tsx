import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../test-fixtures";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
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
    await root.rerender(<SelectedRequirements />);
    container.querySelector("button")?.focus();
    await click("Review game preparation");
    await click("Prepare game data");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent?.includes("Review game preparation")).toBe(
      completion === "replace",
    );
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
  await root.rerender(<SelectedRequirements />);
  await click("Review game preparation");
  await root.rerender(<button>Other selected game</button>);
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
            portId={fixtureValue(owner.split(":")[0], "requirements owner port")}
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
          <button
            key={`navigation:${owner}`}
            ref={(button) => {
              if (owner !== "sample:7") button?.focus();
            }}
          >
            Choose another game
          </button>
          <RequirementsOwner key={owner} owner={owner} />
        </>
      );
    }
    await root.rerender(<SelectedRequirements owner="sample:7" />);
    await click("Review game preparation");
    await root.rerender(<SelectedRequirements owner={nextOwner} />);
    const navigation = container.querySelector("button");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.outerHTML).toContain("Choose another game");
    expect(document.activeElement).toBe(navigation);
  },
);

it.each(["disabled", "unavailable"])(
  "uses the selected requirements fallback when the surviving opener becomes %s",
  async (availability) => {
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
            disabled={availability === "disabled" && disabled}
            focusFallback={() => summary.current}
            run={
              availability === "unavailable" && disabled
                ? undefined
                : async () => {
                    setDisabled(true);
                    return undefined;
                  }
            }
          />
        </details>
      );
    }
    await root.rerender(<SelectedRequirements />);
    await click("Review game preparation");
    await click("Prepare game data");
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(document.activeElement).toBe(container.querySelector("summary"));
  },
);

it("reviews without executing and binds explicit confirmation to the returned plan", async () => {
  const review = vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  const run = vi.fn().mockResolvedValue(plan.inputs.install);
  await root.rerender(
    <PreparationControl portId="sample" generation={7} disabled={false} run={run} />,
  );
  await click("Review game preparation");
  expect(review).toHaveBeenCalledWith("sample", 7);
  expect(run).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.querySelector('[role="dialog"] .preparation-plan')).not.toBeNull();
  expect(document.body.textContent).toContain("E:/owned.iso");
  expect(document.body.textContent).toContain("Prepare game data");
  expect(document.body.textContent).toContain("Selected game files");
  const reviewedFacts = document.body.querySelector(".preparation-plan dl");
  expect(reviewedFacts?.textContent).toContain(plan.inputs.install.version);
  expect(reviewedFacts?.textContent).toContain(plan.inputs.install.path);
  expect(reviewedFacts?.textContent).toContain(plan.inputs.source.path);
  expect(document.body.textContent).toContain("of free space before the game generates output");
  expect(document.body.textContent).toContain("previous version remains available for rollback");
  expect(document.body.textContent).toContain("working files for review in Activity");
  expect(document.body.textContent).toContain("close it without launching the game");
  expect(document.activeElement?.textContent).toBe("Prepare game data");
  expect(document.activeElement?.id).toBe("preparation-review-title");
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("Review game preparation");
  await click("Review game preparation");
  await click("Prepare game data");
  expect(run).toHaveBeenCalledWith("reviewed-plan", expect.any(Function));
  expect(document.body.textContent).toContain("Game data is prepared");
  expect(document.body.textContent).not.toContain("You can now play");
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
  await root.rerender(
    <PreparationControl portId="sample" generation={7} disabled={false} run={run} />,
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
  await root.rerender(
    <PreparationControl portId="sample" generation={7} disabled={false} run={run} />,
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
    await root.rerender(
      <PreparationControl portId="sample" generation={7} disabled={false} run={run} />,
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
  await root.rerender(
    <PreparationControl key="old" portId="sample" generation={7} disabled={false} run={run} />,
  );
  await click("Review game preparation");
  await root.rerender(
    <PreparationControl key="new" portId="other" generation={8} disabled={false} run={run} />,
  );
  await act(async () => complete(plan));
  expect(document.body.textContent).not.toContain("E:/owned.iso");
  expect(run).not.toHaveBeenCalled();
});

it("can leave running preparation without cancellation or completion stealing focus", async () => {
  vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  const cancel = vi.spyOn(desktopApi, "cancelOperation");
  const onPrepared = vi.fn();
  let finish!: (value: PreparationPlan["inputs"]["install"]) => void;
  const run: RunPreparation = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await root.rerender(
    <PreparationControl
      portId="sample"
      generation={7}
      disabled={false}
      run={run}
      onPrepared={onPrepared}
    />,
  );
  await click("Review game preparation");
  await click("Prepare game data");
  await click("Continue browsing");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector(".preparation-control"));
  expect(cancel).not.toHaveBeenCalled();
  const other = document.createElement("button");
  other.textContent = "Other workspace action";
  container.append(other);
  other.focus();
  await act(async () => finish(plan.inputs.install));
  expect(onPrepared).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(other);
});
