import { act } from "react";
import axe from "axe-core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { failureReport, portDefinition } from "../test-fixtures";
import { StatusLayer } from "./Chrome";
import { UpdateCenter } from "./UpdateCenter";
import { useOperationState } from "../features/operations/use-operation-state";
import { failurePresentation } from "../view-model";
import type { ActivityRecord } from "../types";
import { copyText } from "../clipboard";
import { FailureDetails } from "./FailureDetails";
import { ActionReviewFailure } from "./ActionReviewFailure";

vi.mock("../clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
afterEach(() => {
  vi.unstubAllGlobals();
});

it("announces repeated task outcomes without creating duplicate landmarks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let state!: ReturnType<typeof useOperationState>;
  function Fixture() {
    state = useOperationState({ refresh: async () => {} });
    return (
      <StatusLayer clearError={() => state.setError(undefined)} invocations={state.invocations} />
    );
  }
  try {
    await act(async () => root.render(<Fixture />));
    const announcedIds = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => {
        await state.perform("review install", async () => undefined);
      });
      const announcements = [...host.querySelectorAll('[role="status"]')];
      expect(announcements).toHaveLength(1);
      expect(announcements[0]?.textContent).toContain("finished");
      const id = announcements[0]
        ?.closest("[data-invocation-id]")
        ?.getAttribute("data-invocation-id");
      expect(id).toBeTruthy();
      expect(announcedIds.has(id!)).toBe(false);
      announcedIds.add(id!);
    }
    expect(host.querySelectorAll('[data-invocation-id][role="group"]').length).toBe(2);
    expect(announcedIds.size).toBe(2);
    const report = await axe.run(host, {
      runOnly: { type: "rule", values: ["landmark-unique"] },
    });
    expect(report.violations).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

describe("diagnostic clipboard outcomes", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(copyText).mockReset().mockResolvedValue(undefined);
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });
  async function copy() {
    await act(async () => host.querySelector("button")!.click());
  }

  it("shows an exact escaped recovery path before technical details are opened", async () => {
    const error = failureReport();
    const directory = "C:\\Games\\token=literal-player-folder\\<preserve>\\.tfe-preparation";
    error.presentation.summary = `Preparation copies need manual preservation before continuing.\nFolder to preserve: ${directory}`;
    error.presentation.presentation_key = "tfe_preparation_recovery_required";
    error.presentation.mutation_state = "recovery_required";
    error.presentation.technical_context = { recovery_directory: "[REDACTED]" };
    await act(async () => root.render(<ActionReviewFailure error={error} />));
    const summary = host.querySelector('[role="alert"] > p')!;
    expect(summary.textContent).toBe(error.presentation.summary);
    expect(summary.closest("details")).toBeNull();
    expect(summary.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(summary.classList.contains("[unicode-bidi:plaintext]")).toBe(true);
    expect(host.querySelector("preserve")).toBeNull();
    expect(host.querySelector("details")?.open).toBe(false);
  });

  it.each([
    [
      "portable_runtime_modified",
      "Portcove found changed runtime files or unrecognized additions and stopped this operation. Your existing files were preserved. Review the affected paths in technical details. Back up your changes outside the managed installation, then restore changed package files or move unrecognized additions before trying again.",
    ],
    [
      "portable_data_contract_changed",
      "This package changes where player data is stored or how it is located. Portcove stopped the transition and kept the current installation and files. Keep using the current version; use upstream instructions until a compatible package or supported data migration is available.",
    ],
  ])("shows %s recovery instructions before technical details", async (key, summary) => {
    const error = failureReport();
    error.code = "conflict";
    error.presentation.presentation_key = key;
    error.presentation.summary = summary;
    error.presentation.mutation_state = "unknown";
    error.presentation.technical_context = { failures: "package.txt" };
    document.body.append(host);
    try {
      await act(async () => root.render(<ActionReviewFailure error={error} />));
      const message = host.querySelector('[role="alert"] > p')!;
      expect(message.textContent).toBe(summary);
      expect(message.closest("details")).toBeNull();
      expect(message.getBoundingClientRect().height).toBeGreaterThan(0);
      const details = host.querySelector("details")!;
      expect(details.open).toBe(false);
      await act(async () => host.querySelector("summary")!.click());
      expect(details.open).toBe(true);
      expect(details.textContent).toContain("package.txt");
    } finally {
      host.remove();
    }
  });

  it("announces failure with exact selectable details and recovers without changing the outcome", async () => {
    const presentation = failurePresentation(failureReport())!;
    presentation.mutation_state = "committed";
    vi.mocked(copyText).mockRejectedValueOnce(new Error("unrequested private clipboard detail"));
    await act(async () =>
      root.render(
        <FailureDetails
          presentation={presentation}
          code="conflict"
          contextLabel={() => "Named context"}
        />,
      ),
    );
    const consequence = host.querySelector(".failure-details > p")!.textContent;
    await copy();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Clipboard unavailable. Select and copy the technical details below.",
    );
    const fallback = host.querySelector("textarea")!;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.getAttribute("aria-label")).toBe("Technical details for manual copy");
    const expected = JSON.stringify(
      {
        code: "conflict",
        mutation_state: presentation.mutation_state,
        phase: presentation.phase,
        message: presentation.technical_message,
        context: presentation.technical_context,
      },
      null,
      2,
    );
    expect(fallback.value).toBe(expected);
    expect(copyText).toHaveBeenLastCalledWith(expected);
    expect(host.textContent).not.toContain("unrequested private clipboard detail");
    expect(host.querySelector(".failure-details > p")!.textContent).toBe(consequence);
    await copy();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Technical details copied.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(".failure-details > p")!.textContent).toBe(consequence);
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after diagnostic content changes",
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      vi.mocked(copyText).mockReturnValueOnce(
        new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
      );
      const presentation = failurePresentation(failureReport())!;
      await act(async () => root.render(<FailureDetails presentation={presentation} />));
      await copy();
      const current = { ...presentation, technical_message: "current safe details" };
      await act(async () => root.render(<FailureDetails presentation={current} />));
      await act(async () => {
        if (outcome === "success") resolve();
        else reject(new Error("old failure"));
      });
      expect(host.querySelector('[role="status"], [role="alert"]')).toBeNull();
      expect(host.querySelector("button")?.textContent).toBe("Copy technical details");
      await copy();
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Technical details copied.");
      expect(copyText).toHaveBeenLastCalledWith(expect.stringContaining("current safe details"));
    },
  );

  it.each(["success", "failure"])(
    "keeps the newer copy result after an older %s",
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      vi.mocked(copyText).mockReturnValueOnce(
        new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
      );
      const presentation = failurePresentation(failureReport())!;
      await act(async () => root.render(<FailureDetails presentation={presentation} />));
      await copy();
      await copy();
      await act(async () => {
        if (outcome === "success") resolve();
        else reject(new Error("old failure"));
      });
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Technical details copied.");
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(copyText).toHaveBeenCalledTimes(2);
    },
  );

  it("clears completed feedback when the displayed details change", async () => {
    const presentation = failurePresentation(failureReport())!;
    await act(async () => root.render(<FailureDetails presentation={presentation} />));
    host.querySelector("details")!.open = true;
    await copy();
    await act(async () =>
      root.render(<FailureDetails presentation={{ ...presentation, phase: "new-phase" }} />),
    );
    expect(host.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(host.querySelector("button")?.textContent).toBe("Copy technical details");
    expect(host.querySelector("details")!.open).toBe(true);
  });
});

describe("core-owned failure presentation", () => {
  it("retains the original report when the following refresh also fails", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let state!: ReturnType<typeof useOperationState>;
    const refresh = vi.fn().mockRejectedValue(new Error("refresh also failed"));
    function Fixture() {
      state = useOperationState({ refresh });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => {
        root.render(<Fixture />);
      });
      const error = failureReport();
      await act(async () => {
        await state.perform("prepare", () => Promise.reject(error));
      });
      expect(state.error).toBe(error);
      expect(state.busy).toBeUndefined();
      refresh.mockResolvedValue(undefined);
      const cancelled = { ...error, code: "cancelled" };
      cancelled.presentation = { ...error.presentation, mutation_state: "no_changes" };
      await act(async () => {
        await state.perform("prepare", () => Promise.reject(cancelled));
      });
      // A later, proven quiet cancellation cannot erase another invocation's
      // retained failure. Only dismissing that exact feedback removes it.
      expect(state.error).toBe(error);
      const failed = [...state.invocations.values()].find((record) => record.failure === error)!;
      await act(async () => state.dismissInvocation(failed.id));
      expect(state.error).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(["committed", "recovery_required", "unknown", "future_outcome"])(
    "preserves a cancelled %s result through failed readback and dismissal",
    async (outcome) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let state!: ReturnType<typeof useOperationState>;
      const refresh = vi.fn().mockRejectedValue(new Error("later readback failure"));
      function Fixture() {
        state = useOperationState({ refresh });
        return <StatusLayer error={state.error} clearError={() => state.setError(undefined)} />;
      }
      const host = document.createElement("div");
      const root = createRoot(host);
      const error = failureReport();
      error.code = "cancelled";
      error.presentation.tone = "neutral";
      error.presentation.summary = "The operation was cancelled.";
      error.presentation.mutation_state = outcome as typeof error.presentation.mutation_state;
      error.presentation.technical_context = { operation_id: "retained-operation" };
      const original = JSON.stringify(error);
      const task = vi.fn().mockRejectedValue(error);
      try {
        await act(async () => root.render(<Fixture />));
        await act(async () => state.perform("prepare", task));
        expect(state.error).toBe(error);
        expect(state.busy).toBeUndefined();
        expect(state.pendingOperations.size).toBe(0);
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
        expect(host.querySelector("strong")?.textContent).toBe(
          outcome === "committed"
            ? "Change saved; review the current state"
            : outcome === "recovery_required"
              ? "Cancelled operation needs recovery review"
              : "Cancellation outcome needs review",
        );
        expect(host.textContent).not.toContain("No files were changed");
        expect(host.textContent).not.toContain("later readback failure");
        expect(host.querySelector("pre")?.textContent).toContain(outcome);
        expect(host.querySelector("pre")?.textContent).toContain("retained-operation");
        expect(JSON.stringify(error)).toBe(original);
        await act(async () =>
          host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')!.click(),
        );
        expect(state.error).toBeUndefined();
        expect(task).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each(["not_started", "no_changes"] as const)(
    "keeps proven %s cancellation quiet after successful readback",
    async (outcome) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let state!: ReturnType<typeof useOperationState>;
      const refresh = vi.fn().mockResolvedValue(undefined);
      function Fixture() {
        state = useOperationState({ refresh });
        return null;
      }
      const root = createRoot(document.createElement("div"));
      const error = failureReport();
      error.code = "cancelled";
      error.presentation.mutation_state = outcome;
      try {
        await act(async () => root.render(<Fixture />));
        await act(async () => state.perform("prepare", () => Promise.reject(error)));
        expect(state.error).toBeUndefined();
        expect(state.pendingOperations.size).toBe(0);
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each(["missing", "malformed"])(
    "discloses %s cancellation outcomes instead of assuming no changes",
    async (shape) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let state!: ReturnType<typeof useOperationState>;
      const refresh = vi.fn().mockResolvedValue(undefined);
      function Fixture() {
        state = useOperationState({ refresh });
        return <StatusLayer error={state.error} clearError={() => state.setError(undefined)} />;
      }
      const report = failureReport();
      const error = {
        code: "cancelled",
        message: "Cancellation received; outcome unavailable.",
        ...(shape === "malformed"
          ? { presentation: { ...report.presentation, technical_context: null } }
          : {}),
      };
      const host = document.createElement("div");
      const root = createRoot(host);
      try {
        await act(async () => root.render(<Fixture />));
        await act(async () => state.perform("prepare", () => Promise.reject(error)));
        expect(state.error).toBe(error);
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
        expect(host.querySelector("strong")?.textContent).toBe("Cancellation outcome needs review");
        expect(host.textContent).not.toContain("No files were changed");
        expect(state.pendingOperations.size).toBe(0);
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it("shows persisted recovery on remount and opens review without restarting or removing work", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const error = failureReport();
    error.presentation.mutation_state = "recovery_required";
    error.presentation.recovery_actions.unshift("review_preparation");
    const onSelect = vi.fn();
    const port = portDefinition();
    const props = {
      generation: 1,
      ports: [port],
      statuses: new Map(),
      outcomes: [],
      checkAll: vi.fn(),
      diagnosticsRefreshing: false,
      diagnosticsStale: false,
      diagnosticFailure: undefined,
      refreshDiagnostics: vi.fn().mockResolvedValue("completed"),
      onSelect,
      onOpenSettings: vi.fn(),
      activities: [
        {
          id: "recorded",
          operation: "prepare" as const,
          target_kind: "port" as const,
          target_id: port.id,
          status: "failed" as const,
          started_at: 1,
          finished_at: 2,
          cancellation: null,
          failure: error,
          message: "raw-machine-secret",
        },
      ],
    };
    for (let mount = 0; mount < 2; mount++) {
      const host = document.createElement("div");
      const root = createRoot(host);
      try {
        await act(async () => root.render(<UpdateCenter {...props} />));
        expect(host.textContent).toContain(error.presentation.summary);
        expect(host.innerHTML).not.toContain("raw-machine-secret");
        const button = [...host.querySelectorAll("button")].find(
          (item) => item.textContent === "Review setup",
        )!;
        expect(button.dataset.variant).toBe("link");
        await act(async () => button.click());
        expect(onSelect).toHaveBeenLastCalledWith(port.id, "updates:activity:recorded:review");
        expect(host.textContent).not.toMatch(
          /Resume preparation|Retry preparation|Delete retained/,
        );
      } finally {
        await act(async () => root.unmount());
      }
    }
  });

  it("opens the owning Settings control from library activity while leaving unrelated activity inert", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onOpenSettings = vi.fn();
    const now = Math.floor(Date.now() / 1000);
    const operations: ActivityRecord["operation"][] = [
      "discover_sources",
      "move_library",
      "import_library",
      "update_catalog",
      "check_update",
    ];
    const activities: ActivityRecord[] = operations.map((operation, index) => ({
      id: `library-${index}`,
      operation,
      target_kind: "library",
      target_id: null,
      status: "failed",
      started_at: now - index,
      finished_at: now - index,
      cancellation: null,
      failure: null,
      message: null,
    }));
    activities.push({
      id: "source-registration",
      operation: "register_source",
      target_kind: "source",
      target_id: "sample-rom",
      status: "succeeded",
      started_at: now - 6,
      finished_at: now - 6,
      cancellation: null,
      failure: null,
      message: null,
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <UpdateCenter
            generation={1}
            ports={[]}
            statuses={new Map()}
            activities={activities}
            outcomes={[]}
            checkAll={vi.fn()}
            onSelect={vi.fn()}
            onOpenSettings={onOpenSettings}
            diagnosticsRefreshing={false}
            diagnosticsStale={false}
            refreshDiagnostics={vi.fn()}
          />,
        ),
      );
      const routes = [
        ["Game-file search", "Game files", "discover-sources"],
        ["Library move", "Library and storage", "move-library"],
        ["Library restore", "Library and storage", "import-library"],
        ["Catalog update", "Catalog updates", "catalog-updates"],
      ] as const;
      for (const [operation, destination, target] of routes) {
        const row = [...host.querySelectorAll(".activity-row")].find((item) =>
          item.querySelector(".activity-main")?.textContent?.includes(operation),
        );
        const button = row?.querySelector<HTMLButtonElement>(".activity-main button");
        expect(button).not.toBeNull();
        expect(button?.getAttribute("aria-label")).toBe(
          `Open ${destination} settings for Portcove library`,
        );
        await act(async () => button!.click());
        expect(onOpenSettings).toHaveBeenLastCalledWith(target);
      }
      const sourceRow = [...host.querySelectorAll(".activity-row")].find((item) =>
        item.querySelector(".activity-main")?.textContent?.includes("Game-file location update"),
      );
      await act(async () =>
        sourceRow?.querySelector<HTMLButtonElement>(".activity-main button")?.click(),
      );
      expect(onOpenSettings).toHaveBeenLastCalledWith("source-profile", "sample-rom");
      expect(onOpenSettings).toHaveBeenCalledTimes(5);
      expect(host.querySelectorAll(".activity-row")).toHaveLength(6);
      const unrelated = [...host.querySelectorAll(".activity-row")].find((item) =>
        item.querySelector(".activity-main")?.textContent?.includes("Update check"),
      );
      expect(unrelated?.querySelector(".activity-main button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
