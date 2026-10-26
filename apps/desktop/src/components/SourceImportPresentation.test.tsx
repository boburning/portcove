import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import type { BackupProblem, SourceImportPlan, SourceImportResult } from "../types";
import { BackupHistory } from "./BackupHistory";
import {
  SourceImportReview,
  sourceImportModePresentation,
  sourceImportNotice,
} from "./SourceDiscovery";
import { sourceImportFixtures } from "./rendered-test-fixtures";

const { source, plan, result } = sourceImportFixtures();

it.each(["future_mode", "constructor", "__proto__"])(
  "does not offer confirmation or imply preservation for %s",
  (mode) => {
    const review = plan(mode as SourceImportPlan["mode"]);
    const original = JSON.stringify(review);
    const html = renderToStaticMarkup(
      <SourceImportReview plan={review} busy={false} onApply={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(html).toContain("Import method unavailable");
    expect(html).toContain("Cancel review");
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).not.toContain("Keep this location available");
    expect(html).not.toContain('class="primary"');
    expect(sourceImportModePresentation(mode).known).toBe(false);
    expect(JSON.stringify(review)).toBe(original);
    const unknown = sourceImportNotice(result(mode as SourceImportResult["outcome"]));
    expect(unknown).toContain("couldn't confirm how the files were added");
    expect(unknown).not.toMatch(/verified|original was retained|original was removed/);
  },
);

it("distinguishes structural admission from an exact identity in the reviewed plan", () => {
  const structural = renderToStaticMarkup(
    <SourceImportReview plan={plan("copy")} busy={false} onApply={vi.fn()} onCancel={vi.fn()} />,
  );
  const exact = renderToStaticMarkup(
    <SourceImportReview
      plan={{ ...plan("copy"), admission_mode: "exact_identity" }}
      busy={false}
      onApply={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(structural).not.toBe(exact);
  expect(structural).toContain("Structural checks");
  expect(structural).toContain("does not establish an exact edition");
  expect(exact).toContain("Exact identity");
});

it("describes a BIOS import without calling it a game file", () => {
  const biosPlan = {
    ...plan("use_current_location"),
    source: { ...source, path: "D:/Firmware/bios.bin" },
    existing_registration: source,
  };
  const html = renderToStaticMarkup(
    <SourceImportReview plan={biosPlan} busy={false} onApply={vi.fn()} onCancel={vi.fn()} />,
  );
  expect(html).toContain("Selected location:");
  expect(html).toContain("expected files again");
  expect(html).not.toContain("Game file:");
  expect(html).not.toContain("expected game files");
});

it.each([
  ["exact_identity", "Exact identity", "accepted exact identity"],
  ["structural_checks", "Structural checks", "does not establish an exact edition"],
  ["informational_consent", "Informational consent", "does not verify an exact edition"],
  ["upstream_validator", "Upstream validator", "configured upstream validator accepted"],
] as const)(
  "shows the reviewed %s admission basis without changing its plan",
  (mode, label, limit) => {
    const review = { ...plan("copy"), admission_mode: mode };
    const original = JSON.stringify(review);
    const html = renderToStaticMarkup(
      <SourceImportReview
        plan={review}
        profiles={[
          { id: "unrelated", label: "Wrong selected profile" },
          { id: source.profile_id, label: "Reviewed file requirement" },
        ]}
        busy={false}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(html).toContain("Reviewed file requirement");
    expect(html).not.toContain("Wrong selected profile");
    expect(html).toContain(label);
    expect(html).toContain(limit);
    expect(html).toContain("Additional file data planned: 64 B");
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(JSON.stringify(review)).toBe(original);
  },
);

it.each(["future_check", "constructor", "__proto__"])(
  "retains uncertainty and cancel for unknown admission %s",
  (mode) => {
    const review = { ...plan("copy"), admission_mode: mode as SourceImportPlan["admission_mode"] };
    const original = JSON.stringify(review);
    const html = renderToStaticMarkup(
      <SourceImportReview plan={review} busy={false} onApply={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(html).toContain("Source check unavailable");
    expect(html).toContain("Cancel this review and check the files again");
    expect(html).toContain('role="alert"');
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).not.toContain("exact edition was verified");
    expect(JSON.stringify(review)).toBe(original);
  },
);

it.each(["copy", "move", "use_current_location"] as const)(
  "distinguishes reuse for %s and names the old saved reference",
  (mode) => {
    const review = {
      ...plan(mode),
      reuse_existing: true,
      required_bytes: 0,
      existing_registration: { ...source, path: "D:/Old saved files/original.iso" },
    };
    const html = renderToStaticMarkup(
      <SourceImportReview
        plan={review}
        profiles={[{ id: "unrelated", label: "Wrong selected profile" }]}
        busy={false}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(html).toContain("File requirement: <strong>owned</strong>");
    expect(html).not.toContain("Wrong selected profile");
    expect(html).toContain("Currently saved location:");
    expect(html).toContain(review.existing_registration.path);
    expect(html).toContain("Additional file data planned: 0 B");
    const present =
      mode === "use_current_location"
        ? ["Keep this location available"]
        : [
            "existing Portcove copy will be checked and reused",
            "No new file copy is planned",
            mode === "move" ? "original is deleted only after" : "Keep the original",
          ];
    const absent = mode === "use_current_location" ? ["existing Portcove copy"] : [];
    for (const message of present) expect(html).toContain(message);
    for (const message of absent) expect(html).not.toContain(message);
  },
);

it.each([
  ["copied", "Portcove's copy was checked and added; the original was kept."],
  ["reused_existing", "The existing Portcove copy was checked and added; the original was kept."],
  ["moved", "Portcove's copy was checked and added; the original was removed."],
  ["registered_current_location", "Saved the original file location. Keep it available."],
  [
    "copied_original_retained",
    `Portcove's copy was added. The original remains at ${source.path}.`,
  ],
] as const)("retains the specific known %s outcome", (outcome, expected) => {
  const value = result(outcome);
  const original = JSON.stringify(value);
  expect(sourceImportNotice(value)).toBe(expected);
  expect(JSON.stringify(value)).toBe(original);
});

it.each(["future_problem", "constructor", "__proto__"])(
  "renders backup problem %s without an inherited label",
  (kind) => {
    const problem: BackupProblem = {
      kind: kind as BackupProblem["kind"],
      path: "D:/Owned/backup",
      message: "Owned problem",
      proposed_action: "Review the recorded backup",
      backup_id: null,
      operation_id: null,
    };
    const html = renderToStaticMarkup(
      <BackupHistory
        backups={[]}
        state="degraded"
        problems={[problem]}
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(html).toContain("Backup information unavailable");
    expect(html).toContain(problem.path);
  },
);
