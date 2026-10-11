import { describe, expect, it } from "vitest";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { PortDefinition, PortStatus } from "../../types";
import { evaluateCatalogQuery, type CatalogQueryContext } from "./catalog-query";

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
    // This combines declarations and membership; it makes no Linux-managed claim.
    expect(
      ids(
        evaluateCatalogQuery(
          ports,
          { version: 1, platforms: ["linux-x86-64"], membership: ["in-library"] },
          { library: { id: "selected", statuses: new Map([["multi", managed("multi")]]) } },
        ),
      ),
    ).toEqual(["multi"]);
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
    expect(ids(result)).toEqual(["linux"]);
    expect(result.counts.attention["missing-source"]).toBe(0);
    expect(result.counts.attention["finish-setup"]).toBe(1);
    expect(result.counts.channels.stable).toBe(1);
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
