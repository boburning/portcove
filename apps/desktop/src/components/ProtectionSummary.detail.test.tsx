import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { portStatus } from "../test-fixtures";
import { actions, port } from "./rendered-test-fixtures";
import { DetailPanel } from "./DetailPanel";

function button(html: string, text: string) {
  const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
    .map(([value]) => value)
    .find((value) => value.replaceAll(/<[^>]+>/gu, "").trim() === text);
  expect(found, `${text} action exists`).toBeDefined();
  return found!;
}

describe("external-runtime managed backup access", () => {
  const external = {
    id: "external",
    port_id: port.id,
    path: "C:/external",
    executable: "C:/external/game.exe",
    version: "v1",
    platform: "windows-x86-64" as const,
    archive_sha256: "a".repeat(64),
    immutable_tree_sha256: "b".repeat(64),
    registered_at: 1,
  };
  const backup = {
    id: "canonical-backup",
    port_id: port.id,
    path: "C:/library/backups/1",
    created_at: 1,
    file_count: 1,
    size: 10,
    sha256: "c".repeat(64),
  };
  function render({ available = true, busy = false, current = true } = {}) {
    return renderToStaticMarkup(
      <DetailPanel
        port={{
          ...port,
          source_profile: null,
          release: { ...port.release, provider: "user-prepared" },
        }}
        status={{ ...portStatus(), external_runtime: external }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        busy={busy ? "backup" : undefined}
        backups={available ? [backup] : []}
        backupState="healthy"
        backupReadState={{ status: current ? "current" : "failed", hasInventory: true }}
        backupCreateAssessment={{
          action: "backup_create",
          availability: available ? "allowed" : "waiting",
          reason: available ? "available" : "missing_data",
        }}
        backupRestoreAssessment={{
          action: "backup_restore",
          availability: available ? "allowed" : "waiting",
          reason: available ? "available" : "missing_backup",
        }}
      />,
    );
  }

  it("keeps canonical backup history and reviewed actions reachable beside the external-directory exclusion", () => {
    const html = render();
    expect(html).toContain("Portcove does not collect this external runtime directory");
    expect(html).toContain("can still be backed up and restored when Core permits it");
    expect(html).toContain("canonical-backup");
    expect(html).toContain("Back up now");
    const coverage = [
      ...html.matchAll(/<section aria-label="Saved-data coverage">([\s\S]*?)<\/section>/gu),
    ];
    expect(coverage.length).toBeGreaterThan(1);
    for (const [, section] of coverage) expect(section).not.toContain("<code>save</code>");
    expect(html).toContain("coverage could not be verified");
    expect(html).toContain("Runtime collection coverage is unknown");
    expect(button(html, "Restore")).not.toContain("disabled");
  });

  it("keeps missing managed data distinct from protection and external update ownership", () => {
    const html = render({ available: false });
    expect(html).toContain("No saves or settings managed by Portcove were found");
    expect(html).toContain("No backups yet");
    expect(html).not.toContain("canonical-backup");
    expect(button(html, "Back up now")).toContain("disabled");
  });

  it.each([{ busy: true }, { current: false }])(
    "preserves existing unavailable-action guards (%j)",
    (state) => {
      const html = render(state);
      expect(button(html, "Back up now")).toContain("disabled");
      expect(button(html, "Restore")).toContain("disabled");
    },
  );
});
