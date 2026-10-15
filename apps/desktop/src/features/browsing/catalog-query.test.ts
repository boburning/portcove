import { describe, expect, it } from "vite-plus/test";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { PortDefinition, PortStatus } from "../../types";
import { evaluateCatalogQuery, type CatalogQueryContext } from "./catalog-query";
import { observedUpdateCandidate } from "./update-query-context";

const port = (id: string, overrides: Partial<PortDefinition> = {}): PortDefinition => ({
  ...portDefinition(),
  id,
  ...overrides,
});
const method = (
  installation_method: NonNullable<PortDefinition["presentation"]>["installation_method"],
) => ({
  installation_method,
  source_requirements: [],
  saves_and_settings: "portcove-managed" as const,
});
const managed = (id: string): PortStatus => ({
  ...portStatus(),
  port_id: id,
  active: {
    id: "owned-managed",
    port_id: id,
    version: "1",
    path: "/owned/managed",
    channel: "stable",
    installed_at: 1,
    verified: true,
    staged: false,
    artifact: { asset_name: "game.zip", sha256: "a".repeat(64), size: 1 },
    manifest_sha256: "b".repeat(64),
    selected_executable: "game.exe",
    runtime: null,
  },
});
const ports = [
  port("multi", {
    platforms: ["windows-x86-64", "linux-x86-64"],
    channels: ["stable", "beta"],
    presentation: method("portable-package"),
  }),
  port("linux", {
    platforms: ["linux-x86-64"],
    channels: ["rolling"],
    presentation: method("user-prepared-runtime"),
  }),
  port("unknown"),
];
const ids = (result: ReturnType<typeof evaluateCatalogQuery>) => result.ports.map(({ id }) => id);
const external = (id: string): PortStatus => ({
  ...portStatus(),
  port_id: id,
  external_runtime: {
    id: "owned-runtime",
    port_id: id,
    platform: "linux-x86-64",
    path: "/owned/runtime",
    archive_sha256: "a".repeat(64),
    executable: "game",
    immutable_tree_sha256: "b".repeat(64),
    version: "1",
    registered_at: 1,
  },
});

describe("declared catalog query", () => {
  it("uses OR within a group and AND between groups, on the same port", () => {
    expect(
      ids(
        evaluateCatalogQuery(ports, {
          version: 1,
          platforms: ["linux-x86-64"],
          channels: ["stable", "rolling"],
          installationMethods: ["portable-package"],
        }),
      ),
    ).toEqual(["multi"]);
    expect(
      ids(
        evaluateCatalogQuery(ports, {
          version: 1,
          platforms: ["windows-x86-64"],
          installationMethods: ["user-prepared-runtime"],
        }),
      ),
    ).toEqual([]);
  });

  it("leaves empty groups unrestricted and keeps missing presentation unfiltered", () => {
    expect(ids(evaluateCatalogQuery(ports, { version: 1, installationMethods: [] }))).toEqual([
      "multi",
      "linux",
      "unknown",
    ]);
    expect(
      ids(
        evaluateCatalogQuery(ports, {
          version: 1,
          installationMethods: ["portable-package", "user-prepared-runtime"],
        }),
      ),
    ).toEqual(["multi", "linux"]);
  });

  it("separates explicit platform from contextual device selection", () => {
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, platforms: ["windows-x86-64"] },
          { devicePlatform: "linux-x86-64" },
        ),
      ),
    ).toEqual(["multi", "unknown"]);
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, platforms: ["this-device"] },
          { devicePlatform: "linux-x86-64" },
        ),
      ),
    ).toEqual(["multi", "linux"]);
    expect(evaluateCatalogQuery(ports, { version: 1, platforms: ["this-device"] }).state).toBe(
      "unavailable",
    );
  });

  it("retains unsupported restored predicates rather than broadening", () => {
    for (const query of [
      { version: 2 },
      { version: 1, channels: ["renamed-stable"] },
      { version: 1, favorites: [] },
      { version: 1, channels: "stable" },
      null,
    ]) {
      const result = evaluateCatalogQuery(ports, query);
      expect(result.state).toBe("unresolved");
      expect(result.query).toBe(query);
      expect(result.ports).toEqual([]);
      expect(result.counts.channels.stable).toBeNull();
    }
  });

  it("distinguishes an empty selected library from unavailable context", () => {
    const query = { version: 1, membership: ["not-in-library"] };
    expect(evaluateCatalogQuery(ports, query).state).toBe("unavailable");
    expect(
      ids(evaluateCatalogQuery(ports, query, { library: { id: "empty", statuses: new Map() } })),
    ).toEqual(["multi", "linux", "unknown"]);
    expect(
      evaluateCatalogQuery(ports, { version: 1 }).counts.membership["not-in-library"],
    ).toBeNull();
  });

  it("uses only active managed or registered external membership in the supplied library", () => {
    const context: CatalogQueryContext = {
      library: {
        id: "selected",
        statuses: new Map([
          ["multi", managed("multi")],
          ["linux", external("linux")],
        ]),
      },
    };
    expect(
      ids(evaluateCatalogQuery(ports, { version: 1, membership: ["in-library"] }, context)),
    ).toEqual(["multi", "linux"]);
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, membership: ["in-library"] },
          { library: { id: "other", statuses: new Map() } },
        ),
      ),
    ).toEqual([]);
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, membership: ["in-library"] },
          { library: { id: "wrong-identity", statuses: new Map([["multi", external("linux")]]) } },
        ),
      ),
    ).toEqual([]);
  });

  it("does not count staged/previous records as active membership or infer install platform", () => {
    const record = managed("multi").active;
    const statuses = new Map([
      ["multi", { ...portStatus(), port_id: "multi", staged: record, previous: record }],
    ]);
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, membership: ["in-library"] },
          { library: { id: "selected", statuses } },
        ),
      ),
    ).toEqual([]);
    // Legacy port-level declarations cannot prove a coherent installed context.
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, platforms: ["linux-x86-64"], membership: ["in-library"] },
          { library: { id: "selected", statuses: new Map([["multi", managed("multi")]]) } },
        ),
      ),
    ).toEqual([]);
  });

  it("counts each port once after other groups and before its own selection", () => {
    const result = evaluateCatalogQuery([...ports, ports[0]], {
      version: 1,
      platforms: ["windows-x86-64"],
      channels: ["stable"],
      installationMethods: ["portable-package"],
    });
    expect(ids(result)).toEqual(["multi"]);
    expect(result.counts.platforms["linux-x86-64"]).toBe(1);
    expect(result.counts.channels.beta).toBe(1);
    expect(result.counts.channels.rolling).toBe(0);
    expect(result.counts.installationMethods["user-prepared-runtime"]).toBe(0);
    expect(result.counts.platforms["this-device"]).toBeNull();
  });

  it("keeps zero counts when selected constraints have no match", () => {
    const result = evaluateCatalogQuery(ports, {
      version: 1,
      platforms: ["windows-x86-64"],
      installationMethods: ["user-prepared-runtime"],
    });
    expect(result.ports).toEqual([]);
    expect(result.counts.platforms["windows-x86-64"]).toBe(0);
    expect(result.counts.installationMethods["user-prepared-runtime"]).toBe(0);
  });

  it("evaluates an 80-port cached snapshot without I/O or mutation", () => {
    const snapshot = Array.from({ length: 80 }, (_, index) =>
      Object.freeze(port(`port-${index}`, { ...ports[index % ports.length], id: `port-${index}` })),
    );
    Object.freeze(snapshot);
    const query = Object.freeze({ version: 1, channels: Object.freeze(["stable"]) });
    const result = evaluateCatalogQuery(snapshot, query);
    expect(result.ports).toHaveLength(53);
    expect(snapshot).toHaveLength(80);
    expect(result.query).toBe(query);
  });
});

describe("Core installation attention", () => {
  const observed = (
    id: string,
    blockers: NonNullable<PortStatus["readiness"]>["blockers"],
    pending_setup = false,
    registered = false,
  ): PortStatus => ({
    ...(registered ? external(id) : managed(id)),
    readiness: { launchable: true, pending_setup, blockers },
  });
  const contextFor = (entries: [string, PortStatus][]): CatalogQueryContext => ({
    library: { id: "selected", statuses: new Map(entries) },
  });
  it.each([
    ["missing-source", "missing_source"],
    ["missing-bios", "missing_bios"],
    ["missing-runtime", "missing_runtime"],
    ["repair-needed", "invalid_installation"],
    ["finish-setup", "preparation_required"],
  ] as const)("matches %s only from the supplied installed Core reason", (choice, blocker) => {
    const context = contextFor([
      ["multi", observed("multi", [blocker])],
      ["linux", observed("linux", [blocker], false, true)],
    ]);
    expect(ids(evaluateCatalogQuery(ports, { version: 1, attention: [choice] }, context))).toEqual([
      "multi",
      "linux",
    ]);
  });
  it("composes alternative reasons with other groups and counts distinct ports before own selection", () => {
    const context = contextFor([
      ["multi", observed("multi", ["missing_source", "missing_bios"])],
      ["linux", observed("linux", ["invalid_installation"], true, true)],
    ]);
    const query = {
      version: 1,
      attention: ["missing-source", "finish-setup"],
      channels: ["rolling"],
    };
    const result = evaluateCatalogQuery([...ports, ports[1]], query, context);
    expect(result.state).toBe("unavailable");
    expect(result.counts.attention["missing-source"]).toBeNull();
    expect(result.counts.attention["finish-setup"]).toBeNull();
    expect(result.counts.channels.stable).toBeNull();
    // Core pending_setup is independent of launchable.
    expect(context.library?.statuses.get("linux")?.readiness?.launchable).toBe(true);
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, attention: ["missing-source"], membership: ["not-in-library"] },
          context,
        ),
      ),
    ).toEqual([]);
  });
  it.each(["changed_source", "unreadable_source", "changed_bios", "unreadable_bios"] as const)(
    "does not relabel %s as missing",
    (blocker) => {
      const context = contextFor([["multi", observed("multi", [blocker])]]);
      expect(
        ids(
          evaluateCatalogQuery(
            ports,
            { version: 1, attention: ["missing-source", "missing-bios"] },
            context,
          ),
        ),
      ).toEqual([]);
      expect(ids(evaluateCatalogQuery(ports, { version: 1 }, context))).toHaveLength(3);
    },
  );
  it("rejects wrong port/installation identities, stage-only and unknown or malformed readiness", () => {
    const good = observed("multi", ["missing_source"]);
    for (const status of [
      observed("linux", ["missing_source"]),
      { ...good, active: managed("linux").active },
      { ...good, external_runtime: external("linux").external_runtime },
      { ...good, active: null, staged: good.active },
      { ...good, readiness: null },
      { ...good, readiness: { ...good.readiness!, blockers: null } } as unknown as PortStatus,
      { ...good, readiness: { ...good.readiness!, blockers: [42] } } as unknown as PortStatus,
      {
        ...good,
        readiness: { ...good.readiness!, pending_setup: undefined },
      } as unknown as PortStatus,
    ]) {
      const context = contextFor([["multi", status]]);
      expect(
        ids(evaluateCatalogQuery(ports, { version: 1, attention: ["missing-source"] }, context)),
      ).toEqual([]);
      expect(ids(evaluateCatalogQuery(ports, { version: 1 }, context))).toHaveLength(3);
    }
  });
  it("retains unsupported choices and distinguishes absent from confirmed-empty context", () => {
    const query = { version: 1, attention: ["missing-source"] };
    expect(evaluateCatalogQuery(ports, query).state).toBe("unavailable");
    const empty = evaluateCatalogQuery(ports, query, contextFor([]));
    expect(empty.state).toBe("matched");
    expect(empty.ports).toEqual([]);
    expect(empty.counts.attention["missing-source"]).toBe(0);
    const future = { version: 1, attention: ["future-reason"] };
    expect(evaluateCatalogQuery(ports, future, contextFor([]))).toMatchObject({
      state: "unresolved",
      query: future,
      ports: [],
    });
  });
});

describe("identity-bound observed update queries", () => {
  const runtime = {
    origin: "verified_download" as const,
    archive_root: "",
    target_directory: "runtime",
    executable: "game",
    artifact: { asset_name: "runtime.zip", sha256: "c".repeat(64), size: 5 },
  };
  const updated = (id: string, staged = false, runtimeOnly = false): PortStatus => {
    const status = managed(id);
    const active = status.active!;
    const target = {
      ...active,
      id: "candidate",
      version: runtimeOnly ? active.version : "2",
      staged: true,
      artifact: runtimeOnly ? active.artifact : { ...active.artifact, sha256: "d".repeat(64) },
      runtime: runtimeOnly ? runtime : null,
    };
    return {
      ...status,
      staged: staged ? target : null,
      readiness: { launchable: true, pending_setup: false, blockers: [] },
      last_update_check: {
        checked_at: 10,
        check: {
          port_id: id,
          channel: "stable",
          installed_version: active.version,
          installed_artifact: { ...active.artifact },
          installed_runtime: active.runtime,
          required_runtime: target.runtime,
          update_available: true,
          release: {
            version: target.version,
            channel: "stable",
            published_at: null,
            asset: {
              name: target.artifact.asset_name,
              sha256: target.artifact.sha256,
              size: target.artifact.size,
              url: "https://example.com/game.zip",
            },
          },
        },
      },
    };
  };
  const context = (...statuses: PortStatus[]): CatalogQueryContext => ({
    library: { id: "selected", statuses: new Map(statuses.map((s) => [s.port_id, s])) },
  });
  it.each([false, true])(
    "matches available versus staged, including same-version runtime-only updates=%s",
    (runtimeOnly) => {
      const available = updated("multi", false, runtimeOnly);
      const staged = updated("linux", true, runtimeOnly);
      const facts = context(available, staged);
      expect(
        ids(evaluateCatalogQuery(ports, { version: 1, updates: ["available"] }, facts)),
      ).toEqual(["multi"]);
      expect(ids(evaluateCatalogQuery(ports, { version: 1, updates: ["staged"] }, facts))).toEqual([
        "linux",
      ]);
      const result = evaluateCatalogQuery(
        [...ports, ports[1]],
        { version: 1, updates: ["available", "staged"], channels: ["rolling"] },
        facts,
      );
      expect(result.state).toBe("unavailable");
      expect(result.counts.updates.available).toBeNull();
      expect(result.counts.updates.staged).toBeNull();
      expect(result.counts.channels.stable).toBeNull();
      expect(staged.readiness?.launchable).toBe(true);
    },
  );
  it("uses field-wise runtime identity and preserves Core's zero candidate-size convention", () => {
    const status = updated("multi", true, true);
    const check = status.last_update_check!.check;
    check.release.asset.size = 0;
    status.staged!.runtime = {
      executable: runtime.executable,
      artifact: {
        size: 5,
        sha256: runtime.artifact.sha256,
        asset_name: "runtime.zip",
      },
      target_directory: "runtime",
      origin: "verified_download",
      archive_root: "",
    };
    expect(observedUpdateCandidate("multi", status)).toEqual({
      availableAtLastCheck: false,
      matchingStaged: true,
    });
    // Selected channel may differ from the installed record's original channel.
    status.channel = "beta";
    check.channel = "beta";
    check.release.channel = "beta";
    status.staged!.channel = "beta";
    expect(status.active!.channel).toBe("stable");
    expect(observedUpdateCandidate("multi", status)?.matchingStaged).toBe(true);
  });
  it.each([
    "port",
    "active-port",
    "check-port",
    "channel",
    "version",
    "artifact-name",
    "artifact-size",
    "artifact-sha",
    "runtime",
    "candidate-channel",
    "candidate-version",
    "candidate-sha",
    "candidate-size",
    "required-runtime",
    "missing",
    "external-only",
    "boolean",
    "timestamp",
  ])("rejects unknown/obsolete observation %s without claiming up-to-date", (difference) => {
    const status = structuredClone(updated("multi", true));
    const check = status.last_update_check!.check;
    if (difference === "port") status.port_id = "other";
    if (difference === "active-port") status.active!.port_id = "other";
    if (difference === "check-port") check.port_id = "other";
    if (difference === "channel") status.channel = "beta";
    if (difference === "version") status.active!.version = "changed";
    if (difference === "artifact-name") status.active!.artifact.asset_name = "changed.zip";
    if (difference === "artifact-size") status.active!.artifact.size = 2;
    if (difference === "artifact-sha") status.active!.artifact.sha256 = "f".repeat(64);
    if (difference === "runtime") status.active!.runtime = runtime;
    if (difference === "candidate-channel") check.release.channel = "beta";
    if (difference === "candidate-version") check.release.version = "";
    if (difference === "candidate-sha") check.release.asset.sha256 = "";
    if (difference === "candidate-size") check.release.asset.size = -1;
    if (difference === "required-runtime") check.required_runtime = undefined as unknown as null;
    if (difference === "missing") status.last_update_check = null;
    if (difference === "external-only") {
      status.active = null;
      status.external_runtime = external("multi").external_runtime;
    }
    if (difference === "boolean") check.update_available = undefined as unknown as boolean;
    if (difference === "timestamp") status.last_update_check!.checked_at = NaN;
    expect(observedUpdateCandidate("multi", status)).toBeUndefined();
    const facts = { library: { id: "selected", statuses: new Map([["multi", status]]) } };
    expect(
      ids(evaluateCatalogQuery(ports, { version: 1, updates: ["available", "staged"] }, facts)),
    ).toEqual([]);
    expect(ids(evaluateCatalogQuery(ports, { version: 1 }, facts))).toHaveLength(3);
  });
  it.each([
    "port",
    "channel",
    "version",
    "name",
    "size",
    "digest",
    "runtime",
    "unverified",
    "not-staged",
    "runtime-digest-case",
  ])("keeps available when a retained download is not the candidate: %s", (difference) => {
    const status = structuredClone(updated("multi", true));
    const staged = status.staged!;
    if (difference === "port") staged.port_id = "other";
    if (difference === "channel") staged.channel = "beta";
    if (difference === "version") staged.version = "old";
    if (difference === "name") staged.artifact.asset_name = "old.zip";
    if (difference === "size") staged.artifact.size = 2;
    if (difference === "digest") staged.artifact.sha256 = "e".repeat(64);
    if (difference === "runtime") staged.runtime = runtime;
    if (difference === "unverified") staged.verified = false;
    if (difference === "not-staged") staged.staged = false;
    if (difference === "runtime-digest-case") {
      status.last_update_check!.check.required_runtime = runtime;
      staged.runtime = {
        ...runtime,
        artifact: { ...runtime.artifact, sha256: runtime.artifact.sha256.toUpperCase() },
      };
    }
    expect(observedUpdateCandidate("multi", status)).toEqual({
      availableAtLastCheck: true,
      matchingStaged: false,
    });
  });
  it("consumes Core's boolean without recreating eligibility, preserving empty/unavailable and future intent", () => {
    const status = updated("multi", true);
    status.last_update_check!.check.update_available = false;
    expect(observedUpdateCandidate("multi", status)).toEqual({
      availableAtLastCheck: false,
      matchingStaged: false,
    });
    const query = { version: 1, updates: ["staged"] };
    expect(evaluateCatalogQuery(ports, query).state).toBe("unavailable");
    expect(evaluateCatalogQuery(ports, query, context())).toMatchObject({
      state: "matched",
      ports: [],
      counts: { updates: { staged: 0 } },
    });
    expect(evaluateCatalogQuery(ports, { version: 1, updates: ["future"] }, context()).state).toBe(
      "unresolved",
    );
  });
});
