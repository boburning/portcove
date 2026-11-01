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
    expect(html).toContain("No completed backup was found in this read.");
    expect(html).toContain("Its existence alone does not establish save protection.");
    expect(html).toContain("Update ownership is unknown");
    expect(html).toContain("rules, not proof of backed-up saves");
    expect(html).toContain("Custom save locations are not automatically adopted.");
  });

  it.each(["pending", "failed"] as const)(
    "labels retained facts as last loaded after a %s read",
    (state) => {
      const html = render(snapshot(), state);
      expect(html).toContain("Last loaded Core snapshot");
      expect(html).toContain("No completed backup was recorded in the last loaded read.");
      expect(html).not.toContain("Current Core snapshot");
      expect(html).not.toContain("No completed backup was found in this read.");
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
    expect(html).toContain("current restore availability");
    expect(html).toContain("does not prove game-save compatibility");
    expect(html).toContain("Older software");
    expect(html).toContain("may not understand newer saves or configuration");
  });

  it("does not show another implementation’s coverage or backup identity", () => {
    const protection = snapshot();
    protection.port_id = "other-port";
    const html = render(protection);
    expect(html).toContain("Protection information is unavailable");
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
    expect(html).toContain("Protection information is unavailable");
    expect(html).not.toContain("No completed backup");
  });

  it("renders partial protection failure without claiming that no installation exists", () => {
    const protection = snapshot();
    protection.problem = "Registration metadata could not be read";
    const html = render(protection);
    expect(html).toContain(protection.problem);
    expect(html).not.toContain("No installation is recorded");
    expect(html).toContain("Managed backup data root");
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
    expect(html).toContain("Protection information is unavailable");
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
    expect(html).toContain("newest completed backup cannot be established");
    expect(html).toContain("No completed backup could be established from this incomplete read.");
    expect(html).not.toContain("No completed backup was found in this read.");
  });
});
