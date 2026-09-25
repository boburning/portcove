// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failureReport, portDefinition } from "../test-fixtures";
import { StatusLayer } from "./Chrome";
import { UpdateCenter } from "./UpdateCenter";
import { useOperationState } from "../features/operations/use-operation-state";
import { BootstrapRecovery } from "../App";
import { errorText, failurePresentation } from "../view-model";
import type { ActivityRecord } from "../types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("core-owned failure presentation", () => {
  it("names an authoritative commit without inviting a repeat mutation", () => {
    const error = failureReport();
    error.presentation.mutation_state = "committed";
    error.presentation.summary = "The change was saved, but the view could not refresh.";
    const html = renderToStaticMarkup(<StatusLayer error={error} clearError={vi.fn()} />);
    expect(html).toContain("Change saved; review the current state");
    expect(html).toContain(error.presentation.summary);
    expect(html).toContain("The change was committed");
    expect(html).not.toContain("Portcove couldn’t finish that action");
    expect(html).not.toContain("No files were changed");
  });

  it("keeps unknown outcomes visibly uncertain", () => {
    const error = failureReport();
    error.presentation.mutation_state = "unknown";
    const html = renderToStaticMarkup(<StatusLayer error={error} clearError={vi.fn()} />);
    expect(html).toContain("Portcove couldn’t finish that action");
    expect(html).toContain("The changes could not be confirmed");
    expect(html).not.toContain("Change saved; review the current state");
  });

  it("announces a proven no-change cancellation once as a neutral notice", () => {
    const error = failureReport();
    error.presentation.tone = "neutral";
    error.presentation.mutation_state = "no_changes";
    error.presentation.summary = "The operation was cancelled.";
    const html = renderToStaticMarkup(<StatusLayer error={error} clearError={vi.fn()} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Operation cancelled");
    expect(html).toContain("No files were changed by this operation.");
    expect(html).toContain('aria-label="Dismiss notice"');
    expect(html).not.toContain("<p>The operation was cancelled.</p>");
  });

  it.each(["future_outcome", "constructor", "__proto__"])(
    "retains safe copy and the original technical outcome for %s",
    (outcome) => {
      const error = failureReport();
      error.message = "raw-machine-secret";
      error.details = { token: "raw-field-secret" };
      error.presentation.mutation_state = outcome as typeof error.presentation.mutation_state;
      const original = JSON.stringify(error);
      for (const view of [
        <StatusLayer key="status" error={error} clearError={vi.fn()} />,
        <BootstrapRecovery key="bootstrap" error={error} />,
      ]) {
        const html = renderToStaticMarkup(view);
        expect(html).toContain(error.presentation.summary);
        expect(html).toContain("The changes could not be confirmed");
        expect(html).toContain(outcome);
        expect(html).not.toContain("No files were changed");
        expect(html).not.toContain("raw-machine-secret");
        expect(html).not.toContain("raw-field-secret");
      }
      expect(errorText(error)).toBe(error.presentation.summary);
      expect(JSON.stringify(error)).toBe(original);
    },
  );

  it("keeps safe summaries for an unfamiliar tone without announcing cancellation", () => {
    const error = failureReport();
    error.message = "raw-machine-secret";
    error.presentation.tone = "future_tone" as typeof error.presentation.tone;
    const html = renderToStaticMarkup(<StatusLayer error={error} clearError={vi.fn()} />);
    expect(html).toContain(error.presentation.summary);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Operation cancelled");
    expect(html).not.toContain("raw-machine-secret");
    expect(error.presentation.tone).toBe("future_tone");
  });

  it("treats a missing outcome as unknown without changing the retained report", () => {
    const error = failureReport();
    const presentation = { ...error.presentation };
    Reflect.deleteProperty(presentation, "mutation_state");
    const incomplete = { ...error, presentation };
    expect(failurePresentation(incomplete)?.mutation_state).toBe("unknown");
    expect(errorText(incomplete)).toBe(error.presentation.summary);
    expect(incomplete.presentation).not.toHaveProperty("mutation_state");
  });

  it.each(["not_started", "committed", "recovery_required", "unknown"] as const)(
    "does not claim unchanged files for %s",
    (mutation_state) => {
      const error = failureReport();
      error.message = "raw-machine-secret";
      error.details = { token: "raw-field-secret" };
      error.presentation.mutation_state = mutation_state;
      const html = renderToStaticMarkup(<StatusLayer error={error} clearError={vi.fn()} />);
      expect(html).toContain(error.presentation.summary);
      expect(html).toContain("View technical details");
      expect(html).not.toContain("No files were changed");
      expect(html).not.toContain("raw-machine-secret");
      expect(html).not.toContain("raw-field-secret");
    },
  );

  it("uses neutral cancellation and only shows unchanged files with the explicit core outcome", () => {
    const error = failureReport();
    error.code = "cancelled";
    error.presentation.tone = "neutral";
    error.presentation.mutation_state = "no_changes";
    const html = renderToStaticMarkup(<StatusLayer error={error} clearError={vi.fn()} />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("lucide-circle-minus");
    expect(html).toContain("No files were changed by this operation.");
  });

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
      await act(async () => {
        await state.perform("prepare", () => Promise.reject({ ...error, code: "cancelled" }));
      });
      expect(state.error).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  });

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
          (item) => item.textContent === "Review game preparation",
        )!;
        expect(button.dataset.variant).toBe("outline");
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
        ["Game-file search", "Game Files", "game-files"],
        ["Library move", "Library & Storage", "move-library"],
        ["Library restore", "Library & Storage", "import-library"],
        ["Catalog update", "Catalog updates", "catalog-updates"],
      ] as const;
      for (const [operation, destination, target] of routes) {
        const row = [...host.querySelectorAll(".activity-row")].find(
          (item) => item.querySelector(".activity-main strong")?.textContent === operation,
        );
        const button = row?.querySelector<HTMLButtonElement>(".activity-main button");
        expect(button).not.toBeNull();
        expect(button?.getAttribute("aria-label")).toBe(
          `Open ${destination} settings for Portcove library`,
        );
        await act(async () => button!.click());
        expect(onOpenSettings).toHaveBeenLastCalledWith(target);
      }
      expect(onOpenSettings).toHaveBeenCalledTimes(4);
      expect(host.querySelectorAll(".activity-row")).toHaveLength(5);
      const unrelated = [...host.querySelectorAll(".activity-row")].find(
        (item) => item.querySelector(".activity-main strong")?.textContent === "Update check",
      );
      expect(unrelated?.querySelector(".activity-main button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
