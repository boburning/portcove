// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import { SettingsView } from "../../components/Chrome";
import { failureReport, sourceProfile } from "../../test-fixtures";
import type { SourceInspectionReport, SourceRecord } from "../../types";
import { useSourceHealth } from "./use-source-health";

const source: SourceRecord = {
  profile_id: "sample-rom",
  path: "original/game.z64",
  sha256: "a".repeat(64),
  size: 1,
  storage_sha256: "a".repeat(64),
  storage_size: 1,
  updated_at: 1,
};
const failure = failureReport();
failure.presentation.summary = "The file inspection could not complete.";
failure.presentation.technical_message = "Private diagnostic for synthetic inspection";
failure.presentation.technical_context = { private_path: "private/source.z64" };
const report: SourceInspectionReport = {
  schema_version: 1,
  profile_id: source.profile_id,
  health: "current",
  state_code: "recognized_exact",
  summary: "Synthetic successful inspection",
  next_action: "Continue",
  registered: source,
  applications: [],
  evidence: [],
  legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
};
let container: HTMLDivElement;
let root: Root;
let state: ReturnType<typeof useSourceHealth>;
function Fixture({ sources = [source] }: { sources?: SourceRecord[] }) {
  state = useSourceHealth(
    async (_name, task) => task(),
    sources,
    sources.map((item) => item.profile_id),
    "same-catalog",
  );
  return (
    <SettingsView
      libraryRoot="owned/library"
      sourceRequirementsState="available"
      sources={sources}
      sourceProfiles={sources.map((item) => ({
        ...sourceProfile(),
        id: item.profile_id,
        label: "Synthetic cartridge",
      }))}
      sourceInspections={state.inspections}
      sourceOutcomes={state.outcomes}
      sourceInspectionReads={state.inspectionReads}
      retrySourceInspection={state.inspectSource}
      verifySources={() => void state.verifyAll()}
    />
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(desktopApi, "gameFileRoots").mockResolvedValue([]);
  vi.spyOn(desktopApi, "gameFileScanSnapshot").mockResolvedValue(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function row() {
  return container.querySelector<HTMLElement>('[data-source-profile="sample-rom"]')!;
}
function retry() {
  const button = [...row().querySelectorAll("button")].find(
    (item) => item.textContent === "Retry file check",
  );
  expect(button).toBeDefined();
  return button!;
}
it.each(["unknown", "committed"] as const)(
  "keeps %s mutation metadata in technical details for a failed inspection read",
  async (mutationState) => {
    const typedFailure = structuredClone(failure);
    typedFailure.presentation.mutation_state = mutationState;
    const inspect = vi.spyOn(desktopApi, "inspectSource").mockRejectedValue(typedFailure);
    await act(async () => root.render(createElement(Fixture)));
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(row().textContent).not.toContain("Checking file…");
    expect(row().textContent).toContain(failure.presentation.summary);
    expect(row().textContent).toContain("Check unavailable");
    expect(row().querySelector("details[open]")).toBeNull();
    const primary = row().cloneNode(true) as HTMLElement;
    primary.querySelectorAll("details").forEach((item) => item.remove());
    expect(primary.textContent).not.toContain("private/source.z64");
    expect(primary.textContent).not.toContain(failure.presentation.technical_message);
    expect(primary.textContent).not.toContain("couldn't confirm whether anything changed");
    expect(primary.textContent).not.toContain("The change was saved");
    const technical = row().querySelector("details pre")!;
    expect(JSON.parse(technical.textContent!)).toMatchObject({
      code: typedFailure.code,
      mutation_state: mutationState,
      message: typedFailure.presentation.technical_message,
      context: typedFailure.presentation.technical_context,
    });
    expect(retry().disabled).toBe(false);
  },
);
it("coalesces same-turn read-only retry and shows the later successful inspection", async () => {
  let resolve!: (value: SourceInspectionReport) => void;
  const pending = new Promise<SourceInspectionReport>((yes) => {
    resolve = yes;
  });
  const inspect = vi
    .spyOn(desktopApi, "inspectSource")
    .mockRejectedValueOnce(failure)
    .mockReturnValueOnce(pending);
  const verify = vi.spyOn(desktopApi, "verifySources");
  const remove = vi.spyOn(desktopApi, "removeSource");
  const add = vi.spyOn(desktopApi, "addSource");
  await act(async () => root.render(createElement(Fixture)));
  await act(async () => {
    retry().click();
    retry().click();
  });
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(row().textContent).toContain("Checking file…");
  await act(async () => {
    resolve(report);
    await pending;
  });
  expect(row().textContent).toContain(report.summary);
  expect(row().textContent).not.toContain("Checking file…");
  expect(row().textContent).not.toContain(failure.presentation.summary);
  expect(verify).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});
it("uses a safe unavailable message for an unstructured rejection", async () => {
  vi.spyOn(desktopApi, "inspectSource").mockRejectedValue(
    new Error("private/source.z64 secret-debug-input"),
  );
  await act(async () => root.render(createElement(Fixture)));
  expect(row().textContent).not.toContain("Checking file…");
  expect(row().textContent).toContain("File check is unavailable");
  expect(row().textContent).not.toContain("secret-debug-input");
});

it("shows a successful initial inspection without a pending or failure notice", async () => {
  const inspect = vi.spyOn(desktopApi, "inspectSource").mockResolvedValue(report);
  await act(async () => root.render(createElement(Fixture)));
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(row().textContent).toContain(report.summary);
  expect(row().textContent).not.toContain("Checking file…");
  expect(row().textContent).not.toContain("Check unavailable");
});
it("presents cancellation neutrally without a changed-file claim", async () => {
  vi.spyOn(desktopApi, "inspectSource").mockRejectedValue({ code: "cancelled" });
  await act(async () => root.render(createElement(Fixture)));
  expect(row().textContent).toContain("File check cancelled.");
  expect(row().textContent).not.toContain("Checking file…");
  expect(row().textContent).not.toContain("Check unavailable");
  expect(retry().disabled).toBe(false);
});

it("keeps a healthy sibling visible when another current inspection fails", async () => {
  const bios = { ...source, profile_id: "bios", path: "original/bios.bin" };
  const biosReport = {
    ...report,
    profile_id: "bios",
    registered: bios,
    summary: "Synthetic BIOS inspection",
  };
  vi.spyOn(desktopApi, "inspectSource").mockImplementation((id) =>
    id === "bios" ? Promise.resolve(biosReport) : Promise.reject(failure),
  );
  await act(async () => root.render(createElement(Fixture, { sources: [source, bios] })));
  expect(row().textContent).toContain(failure.presentation.summary);
  const healthy = container.querySelector('[data-source-profile="bios"]')!;
  expect(healthy.textContent).toContain(biosReport.summary);
  expect(healthy.textContent).not.toContain("Check unavailable");
  expect(healthy.textContent).not.toContain(failure.presentation.summary);
});
