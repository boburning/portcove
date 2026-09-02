import { describe, expect, it } from "vitest";
import { primaryCliCommand, quoteCliArg } from "./cli-command";
import type { PortDefinition, PortStatus } from "./types";

const port: PortDefinition = {
  id: "sample-port", name: "Sample", summary: "Sample", project_url: "https://example.com",
  support_tier: "stable", channels: ["stable", "beta"], platforms: ["windows-x86-64"],
  automated_tested_platforms: [], manually_validated_platforms: [], adapter: "direct-archive",
  source_profile: "sample-source", bios_source_profile: "sample-bios", persistent_paths: [], upstream_status: "active",
};

describe("GUI to CLI continuity", () => {
  it("renders a non-interactive install command with explicit source requirements", () => {
    expect(primaryCliCommand(port, undefined, "beta", "D:/ROMs/Sample Game.z64", "D:/BIOS/sample.bin")).toBe(
      'portcove --json --non-interactive ensure sample-port --channel beta --source "D:/ROMs/Sample Game.z64" --bios D:/BIOS/sample.bin',
    );
  });

  it("renders the canonical launch command for an active port", () => {
    const status = { port_id: port.id, channel: "stable", update_policy: "notify", active: { id: "1", port_id: port.id, version: "1", path: "sample", channel: "stable", installed_at: 1, verified: true, staged: false } } satisfies PortStatus;
    expect(primaryCliCommand(port, status, "stable")).toBe("portcove exec sample-port --");
  });

  it("quotes values that contain shell-significant whitespace", () => {
    expect(quoteCliArg("simple-id")).toBe("simple-id");
    expect(quoteCliArg("two words")).toBe('"two words"');
  });
});
