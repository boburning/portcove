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
// The review opener stays mounted (hidden) beside the dialog and shares the
// confirm label, so callers scope to the region that owns the intended button.
async function click(label: string, within = "body") {
  const button = [...(document.querySelector(within)?.querySelectorAll("button") ?? [])].find(
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
    await click("Finish setup", ".preparation-control");
    await click("Finish setup", "[role=dialog]");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent?.includes("Finish setup")).toBe(completion === "replace");
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
  await click("Finish setup", ".preparation-control");
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
    await click("Finish setup", ".preparation-control");
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
    await click("Finish setup", ".preparation-control");
    await click("Finish setup", "[role=dialog]");
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(document.activeElement).toBe(container.querySelector("summary"));
  },
);

it("reviews without executing and binds explicit confirmation to the returned plan", async () => {
  const review = vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
  const run = vi.fn().mockResolvedValue(plan.inputs.install);
  await root.rerender(
    <PreparationControl
      portId="sample"
      taskLabel="Sample game · Port: Sample engine"
      generation={7}
      disabled={false}
      run={run}
    />,
  );
  await click("Finish setup", ".preparation-control");
  expect(review).toHaveBeenCalledWith("sample", 7);
  expect(run).not.toHaveBeenCalled();
  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("Sample game · Port: Sample engine");
  expect(dialog?.querySelector(".artwork-image")).not.toBeNull();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.querySelector('[role="dialog"] .preparation-plan')).not.toBeNull();
  expect(document.body.textContent).toContain("E:/owned.iso");
  expect(document.body.querySelector("[role=dialog] #preparation-review-title")?.textContent).toBe(
    "Finish setup",
  );
  expect(
    [...document.body.querySelectorAll(".preparation-plan dt")].map((term) => term.textContent),
  ).toEqual(["Uses", "Starts from", "Needs"]);
  expect(document.body.textContent).toContain(
    "The finished version goes in a new folder beside it.",
  );
  const reviewedFacts = document.body.querySelector(".preparation-plan dl");
  expect(reviewedFacts?.textContent).toContain(plan.inputs.install.version);
  expect(reviewedFacts?.textContent).toContain(plan.inputs.install.path);
  expect(reviewedFacts?.textContent).toContain(plan.inputs.source.path);
  expect(document.body.textContent).toContain("plus what the game creates");
  expect(document.body.textContent).toContain("previous version stays available for rollback");
  expect(document.body.textContent).toContain("working files in Activity");
  expect(document.body.textContent).toContain("close it without starting the game");
  expect(document.activeElement?.textContent).toBe("Finish setup");
  expect(document.activeElement?.id).toBe("preparation-review-title");
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("Finish setup");
  await click("Finish setup", ".preparation-control");
  await click("Finish setup", "[role=dialog]");
  expect(run).toHaveBeenCalledWith("reviewed-plan", expect.any(Function));
  expect(document.body.textContent).toContain("Setup is finished");
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
  await click("Finish setup", ".preparation-control");
  await click("Finish setup", "[role=dialog]");
  expect(document.body.textContent).toContain("Cancel setup");
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
  await click("Finish setup", ".preparation-control");
  await click("Finish setup", "[role=dialog]");
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Inputs changed");
  expect(document.body.textContent).not.toContain("Setup is finished");
  expect(document.activeElement?.textContent).toBe("Finish setup");
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toContain(
    "Finish setup",
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
    await click("Finish setup", ".preparation-control");
    await click("Finish setup", "[role=dialog]");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Finish setup");
    expect(document.body.textContent).not.toContain("Setup is finished");
    expect(document.body.textContent).toContain(
      outcome === "cancelled"
        ? "Setup cancelled"
        : "Setup didn’t finish. Check the selected game files before starting again.",
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
  await click("Finish setup", ".preparation-control");
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
  await click("Finish setup", ".preparation-control");
  await click("Finish setup", "[role=dialog]");
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

it("presents the preparation review and outcomes in the active locale", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
    let finish!: (value: undefined) => void;
    const run: RunPreparation = (_plan, onEvent) => {
      onEvent({ type: "message", message: "Core progress text" } as Parameters<typeof onEvent>[0]);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    await root.rerender(
      <PreparationControl portId="sample" generation={7} disabled={false} run={run} />,
    );
    expect(document.querySelector("section")?.getAttribute("aria-label")).toBe("إكمال الإعداد");
    await click("إكمال الإعداد", ".preparation-control");
    const dialog = () => document.querySelector("[role=dialog]");
    expect(dialog()?.textContent).toContain("الإصدار المثبت 1.2");
    expect(dialog()?.querySelector("[aria-label='ملخص الإعداد']")).not.toBeNull();
    expect(dialog()?.textContent).toContain("إذا فتح الإعداد نافذة أخرى");
    expect(
      [...(dialog()?.querySelectorAll("bdi[dir=ltr]") ?? [])].map((item) => item.textContent),
    ).toEqual([plan.inputs.source.path, plan.inputs.install.path]);
    await click("إكمال الإعداد", "[role=dialog]");
    expect(document.querySelector("[role=status]")?.textContent).toBe("Core progress text");
    expect(dialog()?.textContent).toContain("أبقِ Portcove مفتوحًا.");
    await act(async () => finish(undefined));
    expect(document.querySelector("[role=status]")?.textContent).toBe(
      "لم يكتمل الإعداد. تحقق من ملفات اللعبة المحددة قبل البدء مرة أخرى.",
    );
  } finally {
    await localization.changeLanguage("en");
  }
});

it("translates the prepared and cancelled outcomes and the space line", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    vi.spyOn(desktopApi, "planPreparation").mockResolvedValue(plan);
    let outcome: "prepared" | "cancelled" = "prepared";
    const run: RunPreparation = async () => {
      if (outcome === "cancelled")
        throw Object.assign(new Error("Cancelled"), { code: "cancelled" });
      return plan.inputs.install;
    };
    await root.rerender(
      <PreparationControl portId="sample" generation={7} disabled={false} run={run} />,
    );
    await click("Finish setup", ".preparation-control");
    expect(document.querySelector("[role=dialog]")?.textContent).toMatch(
      /At least .+ free, plus what the game creates/u,
    );
    await click("Finish setup", "[role=dialog]");
    expect(document.querySelector("[role=status]")?.textContent).toBe("Setup is finished.");
    await localization.changeLanguage("ar-XB");
    outcome = "cancelled";
    await click("إكمال الإعداد", ".preparation-control");
    expect(document.querySelector("[role=dialog]")?.textContent).toMatch(
      /.+ مساحة حرة على الأقل، إضافةً إلى ما تنشئه اللعبة/u,
    );
    await click("إكمال الإعداد", "[role=dialog]");
    expect(document.querySelector("[role=status]")?.textContent).toBe(
      "أُلغي الإعداد. راجع النشاط الحديث لمعرفة العمل غير المكتمل.",
    );
  } finally {
    await localization.changeLanguage("en");
  }
});
