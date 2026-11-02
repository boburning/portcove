import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { BackupInventory } from "../types";
import { portStatus } from "../test-fixtures";
import { ProtectionSummary } from "./ProtectionSummary";

type Protection = NonNullable<BackupInventory["protection"]>;
const declaration = {
  definition_sha256: "a".repeat(64),
  saves_and_settings: "portcove-managed" as const,
  persistent_paths: ["saves", "settings.ini"],
  persistent_file_patterns: [],
};
function snapshot(): Protection {
  return {
    port_id: "sample",
    catalog: declaration,
    managed_data: { path: "C:/library/user/sample", state: "present" },
    installations: [],
    latest_completed_backup: null,
    exclusions: ["Custom save locations are not automatically adopted."],
    problem: null,
  };
}
function render(protection = snapshot(), status: "current" | "pending" | "failed" = "current") {
  return renderToStaticMarkup(
    <ProtectionSummary
      portId="sample"
      status={portStatus()}
      protection={protection}
      inventoryState="healthy"
      readState={{ status, hasInventory: true }}
    />,
  );
}

describe("player-data protection summary", () => {
  it("does not turn a managed declaration or existing folder into a completed backup", () => {
    const html = render();
    expect(html).toContain("No completed backup recorded.");
    expect(html).toContain("This folder’s presence doesn’t mean its contents have been backed up.");
    expect(html).toContain("Choose an installation to see who handles updates");
    expect(html).toContain("rules, not proof of backed-up saves");
    expect(html).toContain("Custom save locations are not automatically adopted.");
  });

  it.each(["pending", "failed"] as const)(
    "labels retained facts as last loaded after a %s read",
    (state) => {
      const html = render(snapshot(), state);
      expect(html).toContain("Last loaded backup information");
      expect(html).toContain("No completed backup was listed when backup history was last loaded.");
      expect(html).not.toContain("Latest backup information");
      expect(html).not.toContain("No completed backup recorded.");
    },
  );

  it("keeps the latest completed backup distinct from current eligibility and game compatibility", () => {
    const protection = snapshot();
    protection.latest_completed_backup = {
      id: "completed-backup-1",
      port_id: "sample",
      path: "C:/library/backups/1",
      created_at: 42,
      file_count: 2,
      size: 30,
      sha256: "b".repeat(64),
    };
    const html = render(protection);
    expect(html).toContain("Latest completed backup");
    expect(html).toContain("completed-backup-1");
    expect(html).toContain("Review its files before restoring");
    expect(html).toContain("older versions may not be able to use these saves");
    expect(html).toContain("Newer saves");
    expect(html).toContain("may not work with it");
  });

  it("does not show another implementation’s coverage or backup identity", () => {
    const protection = snapshot();
    protection.port_id = "other-port";
    const html = render(protection);
    expect(html).toContain("Backup information is unavailable");
    expect(html).not.toContain("C:/library/user/sample");
    expect(html).not.toContain(declaration.definition_sha256);
  });

  it("does not treat missing old-client protection data as an empty backup inventory", () => {
    const html = renderToStaticMarkup(
      <ProtectionSummary
        portId="sample"
        status={portStatus()}
        readState={{ status: "current", hasInventory: true }}
      />,
    );
    expect(html).toContain("Backup information is unavailable");
    expect(html).not.toContain("No completed backup");
  });

  it("renders partial protection failure without claiming that no installation exists", () => {
    const protection = snapshot();
    protection.problem = "Registration metadata could not be read";
    const html = render(protection);
    expect(html).toContain(protection.problem);
    expect(html).not.toContain("No installation is recorded");
    expect(html).toContain("Saved-data folder");
  });

  it("refuses stale installation facts even when the port identity is unchanged", () => {
    const protection = snapshot();
    protection.installations = [
      {
        install_id: "previous-generation",
        version: "v1",
        install_root: "C:/old",
        role: "previous",
        update_owner: "portcove",
        retained: declaration,
        effective: declaration,
        collection: "inactive",
        collection_root: null,
        collection_candidates: [],
        exclusions: [],
        problem: null,
      },
    ];
    const html = render(protection);
    expect(html).toContain("Backup information is unavailable");
    expect(html).not.toContain("previous-generation");
  });
  it("does not call a fulfilled unreadable inventory empty", () => {
    const html = renderToStaticMarkup(
      <ProtectionSummary
        portId="sample"
        status={portStatus()}
        protection={snapshot()}
        readState={{ status: "current", hasInventory: true }}
        inventoryState="degraded"
        problems={[
          {
            kind: "unreadable_manifest",
            backup_id: null,
            operation_id: null,
            path: "C:/library/backups",
            message: "Cannot list backup root",
            proposed_action: "Check access",
          },
        ]}
      />,
    );
    expect(html).toContain("We couldn’t confirm your latest completed backup");
    expect(html).toContain(
      "We couldn’t confirm a completed backup because the history is incomplete.",
    );
    expect(html).not.toContain("No completed backup recorded.");
  });
});
