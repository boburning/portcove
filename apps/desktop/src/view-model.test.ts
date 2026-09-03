import { describe, expect, it } from "vitest";
import type { InstallRecord, PortDefinition, PortStatus } from "./types";
import { currentUpdateSnapshot, errorText, filterOptions, filterPorts, indexStatuses, mostRecentPort, portReadiness, requiredSourceNeeds, summarizeLibrary } from "./view-model";

const port = (id: string, channels: PortDefinition["channels"]): PortDefinition => ({
  id, name: id === "alpha" ? "Alpha Port" : "Beta Port", summary: `${id} summary`,
  project_url: `https://example.com/${id}`, support_tier: channels[0], channels,
  platforms: ["windows-x86-64"], adapter: "staged-source-portable", persistent_paths: ["save"], upstream_status: "active",
  automated_tested_platforms: [], manually_validated_platforms: [],
  release: {}, executable_hints: {},
});
const installRecord = (overrides: Partial<InstallRecord> = {}): InstallRecord => ({
  id: "1", port_id: "alpha", version: "1.0", path: "alpha/1.0", channel: "stable", installed_at: 1, verified: true, staged: false,
  artifact: { asset_name: "alpha.zip", sha256: "b".repeat(64), size: 1 }, manifest_sha256: "c".repeat(64), selected_executable: "alpha.exe",
  ...overrides,
});

describe("catalog view model", () => {
  const ports = [port("alpha", ["stable"]), port("beta", ["beta", "rolling"])];
  const status: PortStatus = { port_id: "alpha", channel: "stable", update_policy: "notify", active: installRecord() };

  it("indexes statuses and restricts the library to installed ports", () => {
    const statuses = indexStatuses([status]);
    expect(statuses.get("alpha")).toEqual(status);
    expect(filterPorts(ports, statuses, "library", "all", "").map(value => value.id)).toEqual(["alpha"]);
  });

  it("combines channel and text filters", () => {
    expect(filterPorts(ports, new Map(), "catalog", "rolling", "BETA").map(value => value.id)).toEqual(["beta"]);
  });

  it("distinguishes playable installs from missing-source setup", () => {
    const withSource = { ...ports[0], source_profile: "alpha-source" };
    const statuses = indexStatuses([status]);
    expect(portReadiness(withSource, status, new Set())).toBe("source");
    expect(portReadiness(withSource, status, new Set(["alpha-source"]))).toBe("ready");
    expect(filterPorts([withSource], statuses, "library", "setup", "", new Set()).map(value => value.id)).toEqual(["alpha"]);
    expect(summarizeLibrary([withSource], statuses, new Set())).toEqual({ installed: 1, ready: 0, needsSetup: 1, staged: 0 });
    expect(filterOptions("library")).toEqual(["all", "ready", "setup"]);
    expect(filterOptions("catalog")).toEqual(["all", "stable", "beta", "rolling"]);
  });

  it("keeps one-time upstream setup separate from missing sources", () => {
    const withSetup = { ...ports[0], source_profile: "alpha-source", setup_marker: "data/ready.txt" };
    const pending: PortStatus = {
      ...status,
      readiness: { launchable: true, blockers: [], pending_setup: true },
    };
    expect(portReadiness(withSetup, pending, new Set(["alpha-source"]))).toBe("setup");

    const blocked: PortStatus = {
      ...pending,
      readiness: { launchable: false, blockers: ["missing_source"], pending_setup: true },
    };
    expect(portReadiness(withSetup, blocked, new Set(["alpha-source"]))).toBe("source");
  });

  it("selects Continue from successful launch history only", () => {
    const beta: PortStatus = { ...status, port_id: "beta", last_launched_at: 20 };
    const alpha: PortStatus = { ...status, last_launched_at: 10 };
    expect(mostRecentPort(ports, indexStatuses([alpha, beta]))?.port.id).toBe("beta");
    expect(mostRecentPort(ports, indexStatuses([{ ...status, last_launched_at: undefined }]))).toBeUndefined();
  });

  it("uses only update snapshots that still describe the active version and channel", () => {
    const snapshot = {
      checked_at: 10,
      check: {
        port_id: "alpha", channel: "stable" as const, installed_version: "1.0", installed_artifact: status.active!.artifact, update_available: true,
        release: { version: "2.0", channel: "stable" as const, asset: { name: "alpha.zip", url: "https://example.com/alpha.zip", size: 1, sha256: "a".repeat(64) } },
      },
    };
    expect(currentUpdateSnapshot({ ...status, last_update_check: snapshot })).toEqual(snapshot);
    expect(currentUpdateSnapshot({ ...status, active: { ...status.active!, version: "2.0" }, last_update_check: snapshot })).toBeUndefined();
    expect(currentUpdateSnapshot({ ...status, channel: "beta", last_update_check: snapshot })).toBeUndefined();
    expect(currentUpdateSnapshot({ ...status, active: { ...status.active!, runtime: {
      origin: "verified_download", artifact: { asset_name: "runtime.zip", sha256: "d".repeat(64), size: 10 },
      archive_root: "vendor", target_directory: "runtime", executable: "bin/java",
    } }, last_update_check: snapshot })).toBeUndefined();
  });

  it("groups missing source and BIOS requirements for installed ports only", () => {
    const configured = [
      { ...ports[0], source_profile: "shared-source" },
      { ...ports[1], source_profile: "beta-source", bios_source_profile: "shared-source" },
    ];
    const statuses = indexStatuses([status, { ...status, port_id: "beta", active: { ...status.active!, port_id: "beta" } }]);
    const profiles = [
      { id: "shared-source", label: "Shared original disc", accepted_extensions: ["chd"] },
      { id: "beta-source", label: "Beta cartridge", accepted_extensions: ["z64"] },
    ];
    const requirements = requiredSourceNeeds(configured, profiles, statuses, [{
      profile_id: "beta-source", path: "D:/beta.z64", sha256: "a", size: 1, storage_sha256: "a", storage_size: 1, updated_at: 1,
    }]);

    expect(requirements).toHaveLength(1);
    expect(requirements[0].profile.id).toBe("shared-source");
    expect(requirements[0].requiredBy).toEqual([
      { portId: "alpha", portName: "Alpha Port", role: "Game source" },
      { portId: "beta", portName: "Beta Port", role: "BIOS" },
    ]);
  });

  it("normalizes structured and primitive errors", () => {
    expect(errorText({ code: "bad", message: "Readable", details: {} })).toBe("Readable");
    expect(errorText("failure")).toBe("failure");
  });
});
