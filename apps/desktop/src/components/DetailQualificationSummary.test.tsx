import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import catalog from "../../../../crates/portcove-core/catalog/catalog.json";
import type { PortDefinition, SourceInspectionReport } from "../types";
import type { SourceCatalog } from "../transport-types.generated";
import { DetailPanel, type DetailActions } from "./DetailPanel";
import { DetailQualificationSummary } from "./DetailQualificationSummary";
import { portStatus } from "../test-fixtures";

const sourceCatalog = catalog.source_catalog as unknown as SourceCatalog;
const snap64 = catalog.ports.find(
  (port) => port.id === "snap64-recomp",
) as unknown as PortDefinition;

function report(port = snap64, role: "game" | "bios" = "game"): SourceInspectionReport {
  const profile = role === "game" ? port.source_profile : port.bios_source_profile;
  const contract = sourceCatalog.contracts.find(
    (candidate) => candidate.port_id === port.id && candidate.role === role,
  );
  if (!profile || !contract) throw new Error("Missing catalog source fixture");
  return structuredClone({
    schema_version: 1,
    profile_id: profile,
    health: "current",
    state_code: "not_inspected",
    summary: "No fresh file inspection",
    next_action: "Select files",
    expected_identity: sourceCatalog.identities.find((identity) => identity.id === profile),
    applications: [
      {
        port_id: port.id,
        port_name: port.name,
        role,
        contract,
        contract_result: { state: "not_evaluated" },
        release_applicability: { state_code: "not_rebound", reviewed_bindings: [] },
        qualification: {
          legacy_automated_platforms: [],
          legacy_hands_on_platforms: [],
          exact_records: sourceCatalog.qualification.filter(
            (record) => record.scope.port_id === port.id,
          ),
        },
      },
    ],
    evidence: [],
    legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
  });
}

const actions = Object.fromEntries(
  [
    "activate",
    "backup",
    "check",
    "close",
    "deleteBackup",
    "dismissInstallReview",
    "install",
    "launch",
    "openUserData",
    "reviewInstall",
    "restoreBackup",
    "rollback",
    "remove",
    "setChannel",
    "setPolicy",
    "verify",
  ].map((name) => [name, vi.fn()]),
) as unknown as DetailActions;

function details(
  sourceInspection?: SourceInspectionReport,
  port = snap64,
  biosInspection?: SourceInspectionReport,
) {
  const markup = renderToStaticMarkup(
    <DetailPanel
      port={port}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
      sourceInspection={sourceInspection}
      biosInspection={biosInspection}
    />,
  );
  return markup.split("Compatibility and testing")[1]?.split("Project and release")[0] ?? "";
}

describe("detail qualification history", () => {
  it("shows Snap64's recorded checks and scoped failure despite empty legacy platform arrays", () => {
    const markup = details(report());
    expect(markup).toContain("Structural check");
    expect(markup).toContain("Automated lifecycle");
    expect(markup).toContain("Known failure");
    expect(markup).toContain("165 Hz host");
    expect(markup).toContain("v1.0.5");
    expect(markup).toContain("Recorded history");
    expect(markup).not.toContain("No automated test recorded");
  });

  it("keeps missing reports distinct from absent catalog evidence", () => {
    const markup = details();
    expect(markup).toContain("File-check report unavailable");
    expect(markup).toContain("Catalog evidence may still exist");
    expect(markup).toContain("No legacy platform coverage recorded");
    expect(markup).not.toContain("No automated test recorded");
  });

  it.each([
    [
      "report profile",
      (value: SourceInspectionReport) => {
        value.profile_id = "other";
      },
    ],
    [
      "application port",
      (value: SourceInspectionReport) => {
        value.applications[0].port_id = "other";
      },
    ],
    [
      "application role",
      (value: SourceInspectionReport) => {
        value.applications[0].role = "bios";
      },
    ],
    [
      "contract profile",
      (value: SourceInspectionReport) => {
        value.applications[0].contract.profile_id = "other";
      },
    ],
    [
      "contract port",
      (value: SourceInspectionReport) => {
        value.applications[0].contract.port_id = "other";
      },
    ],
    [
      "contract role",
      (value: SourceInspectionReport) => {
        value.applications[0].contract.role = "bios";
      },
    ],
  ])("rejects mismatched %s without turning it into evidence absence", (_name, change) => {
    const value = report();
    change(value);
    const markup = details(value);
    expect(markup).toContain("File-check report unavailable");
    expect(markup).not.toContain("165 Hz host");
  });

  it.each(["port", "contract", "game", "variant", "format", "identity-profile"])(
    "does not promote records with a mismatched %s identity",
    (dimension) => {
      const value = report();
      for (const record of value.applications[0].qualification.exact_records) {
        if (dimension === "port") record.scope.port_id = "other";
        if (dimension === "contract") record.scope.contract_id = "other";
        if (record.scope.variant.state === "exact") {
          if (dimension === "game") record.scope.variant.identity.game_id = "other";
          if (dimension === "variant") record.scope.variant.identity.variant_id = "other";
          if (dimension === "format") record.scope.variant.identity.representation_id = "other";
        }
      }
      if (dimension === "identity-profile") value.expected_identity = null;
      const markup = details(value);
      expect(markup).toContain("Some recorded scopes could not be verified");
      expect(markup).not.toContain("165 Hz host");
    },
  );

  it("does not carry a previous port's report into a newly selected port", () => {
    const otherPort = { ...snap64, id: "other-port", name: "Other port" };
    expect(details(report(), otherPort)).not.toContain("165 Hz host");
    expect(details(report(), otherPort)).toContain("File-check report unavailable");
  });

  it("shows BIOS evidence only through its own role and source profile", () => {
    const biosPort = catalog.ports.find(
      (port) => port.id === "mortal-kombat-4-recompiled",
    ) as unknown as PortDefinition;
    const bios = report(biosPort, "bios");
    const application = bios.applications[0];
    const variant = bios.expected_identity!.variants.find((candidate) =>
      application.contract.supported_variant_ids.includes(candidate.id),
    )!;
    const record = structuredClone(sourceCatalog.qualification[0]);
    record.method = "Recorded BIOS structural observation";
    record.scope.port_id = biosPort.id;
    record.scope.contract_id = application.contract.id;
    record.scope.variant = {
      state: "exact",
      identity: {
        game_id: bios.profile_id,
        variant_id: variant.id,
        representation_id: variant.representations[0].id,
      },
    };
    application.qualification.exact_records = [record];
    const markup = details(undefined, biosPort, bios);
    expect(markup).toContain("BIOS recorded observations");
    expect(markup).toContain(record.method);
    expect(details(bios, biosPort)).not.toContain(record.method);
  });

  it("preserves different kinds and failed, not-run and unknown outcomes", () => {
    const value = report();
    const original = value.applications[0].qualification.exact_records[0];
    value.applications[0].qualification.exact_records = [
      { ...original, kind: "hands_on", outcome: "not_run", method: "Hands-on was not run" },
      {
        ...original,
        kind: "automated_lifecycle",
        outcome: "unknown",
        method: "Lifecycle result unknown",
      },
      {
        ...original,
        kind: "structural_check",
        outcome: "failed",
        method: "Structural check failed",
      },
    ];
    const markup = details(value);
    expect(markup).toContain("Hands-on observation · Not run");
    expect(markup).toContain("Automated lifecycle · Outcome unknown");
    expect(markup).toContain("Structural check · Failed");
    expect(markup).not.toContain("· Passed");
  });

  it("does not treat incomplete recorded release or variant scope as a wildcard", () => {
    const value = report();
    const record = value.applications[0].qualification.exact_records[0];
    record.scope.artifact_sha256 = null;
    record.scope.upstream_ref = null;
    record.scope.check_version = null;
    record.scope.variant = { state: "unspecified" };
    value.applications[0].qualification.exact_records = [record];
    const markup = details(value);
    expect(markup).toContain(record.method);
    expect(markup.match(/Not recorded — scope unknown/g)).toHaveLength(2);
    expect(markup).toContain("Current applicability is unknown");
    expect(markup).toContain("not a fresh check");
  });

  it("keeps legacy platform coverage alongside recorded exact history", () => {
    const markup = details(report(), { ...snap64, automated_tested_platforms: ["linux-x86-64"] });
    expect(markup).toContain("Legacy port-wide automated tests");
    expect(markup).toContain("Linux · Not recorded: Windows");
    expect(markup).toContain("Structural check · Passed");
    expect(markup).toContain("Known failure · Failed");
    expect(markup).toContain("2026-09-13");
    expect(markup).not.toContain("snap64-windows-qualification-v1");
    expect(markup).not.toContain("usa-rev0");
    expect(markup).toContain("Pokemon Snap · USA · Rev 0");
    const technical = renderToStaticMarkup(
      <DetailQualificationSummary port={snap64} sourceInspection={report()} technical />,
    );
    expect(technical).toContain("snap64-windows-qualification-v1");
    expect(technical).toContain("usa-rev0");
    expect(technical).toContain(
      sourceCatalog.qualification.find((record) => record.scope.port_id === snap64.id)!.scope
        .artifact_sha256!,
    );
  });

  it("escapes recorded methods and renders no new interactive control", () => {
    const value = report();
    value.applications[0].qualification.exact_records[0].method = "<script>unsafe</script>";
    const markup = renderToStaticMarkup(
      <DetailQualificationSummary port={snap64} sourceInspection={value} />,
    );
    expect(markup).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(markup).not.toMatch(/<button|<a |<input|tabindex=/);
  });

  it.each(["user-prepared", "external"])(
    "keeps exact technical scope available for %s runtimes without managed actions",
    (mode) => {
      const port = {
        ...snap64,
        release: {
          ...snap64.release,
          provider: mode === "user-prepared" ? ("user-prepared" as const) : snap64.release.provider,
          user_prepared: {},
        },
      };
      const status =
        mode === "external"
          ? {
              ...portStatus(),
              external_runtime: {
                id: "owned-external",
                port_id: port.id,
                path: "owned-runtime",
                executable: "owned-runtime/game.exe",
                version: "1.0.5",
                platform: "windows-x86-64" as const,
                archive_sha256: "a".repeat(64),
                immutable_tree_sha256: "b".repeat(64),
                registered_at: 1,
              },
            }
          : undefined;
      const markup = renderToStaticMarkup(
        <DetailPanel
          port={port}
          status={status}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
          sourceInspection={report()}
        />,
      );
      const technical = markup.split("Technical details").at(-1)!;
      expect(technical).toContain("snap64-windows-qualification-v1");
      expect(technical).toContain("usa-rev0");
      expect(technical).not.toContain("Commands and maintenance");
      expect(technical).not.toContain("Saved data patterns");
      expect(technical).not.toContain("Set up from the command line");
      expect(technical).not.toContain("Steam shortcut");
    },
  );
});
