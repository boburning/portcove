import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { SettingsView } from "./components/Chrome";
import { PortBrowser } from "./components/PortBrowser";
import { ReleaseChannelControl } from "./components/ReleaseChannel";
import { portDefinition, portStatus } from "./test-fixtures";
import type { GithubAuthStatus, PortDefinition, PortStatus, ReleaseChannel } from "./types";
import { formatBytes, platformLabel } from "./view-model";

describe("catalog and capacity presentation", () => {
  it.each([
    {
      status: undefined,
      installationLabel: "Installation status unknown",
      absentInstallationLabel: "Not installed",
    },
    {
      status: portStatus(),
      installationLabel: "Not installed",
      absentInstallationLabel: "Installation status unknown",
    },
  ])(
    "keeps a missing Catalog setup assessment unknown: $installationLabel",
    ({ status, installationLabel, absentInstallationLabel }) => {
      const port = portDefinition();
      const html = renderToStaticMarkup(
        <PortBrowser
          view="catalog"
          ports={[port]}
          statuses={new Map(status ? [[port.id, status]] : [])}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={vi.fn()}
          loading={false}
        />,
      );
      expect(html).toContain("Setup status unknown");
      expect(html).toContain("View details");
      expect(html).not.toContain("Available");
      expect(html).not.toContain("Unsupported");
      const card = html.match(/<button[^>]*class="port-card [^>]*>/u)?.[0];
      expect(card).toBeDefined();
      expect(card).not.toContain(" disabled=");
      expect(html).toContain(installationLabel);
      expect(html).not.toContain(absentInstallationLabel);
    },
  );

  it("separates observed uninstalled membership from Catalog setup eligibility", () => {
    const port = portDefinition();
    const status: PortStatus = {
      ...portStatus(),
      readiness: { launchable: false, blockers: ["missing_source"], pending_setup: false },
    };
    const html = renderToStaticMarkup(
      <PortBrowser
        view="catalog"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(html).toContain("Not installed");
    expect(html).not.toContain("Available");
    expect(html).not.toContain("Ready to play");
    const card = html.match(/<button[^>]*class="port-card [^>]*>/u)?.[0];
    expect(card).toBeDefined();
    expect(card).not.toContain(" disabled=");
  });

  it.each([
    ["allowed", "available", "Setup available", "Current setup checks passed"],
    ["waiting", "missing_source", "Setup needs review", "Required game files are missing"],
    ["waiting", "missing_bios", "Setup needs review", "A required BIOS file is missing"],
    ["held", "definition_ineligible", "Setup on hold", "do not match the required edition"],
    ["not_offered", "unsupported_platform", "Setup unavailable", "on this platform"],
  ] as const)(
    "shows cached %s/%s setup reasons with enabled Details",
    (availability, reason, label, explanation) => {
      const port = portDefinition();
      const status: PortStatus = {
        ...portStatus(),
        port_actions: [
          {
            action: "install",
            availability,
            reason,
            ...(reason === "definition_ineligible"
              ? {
                  definition: {
                    outcome: "hold" as const,
                    reason: "source_identity_mismatch" as const,
                  },
                }
              : {}),
          },
          { action: "register_external", availability: "not_offered", reason: "route_not_offered" },
        ],
      };
      const html = renderToStaticMarkup(
        <PortBrowser
          view="catalog"
          ports={[port]}
          statuses={new Map([[port.id, status]])}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={vi.fn()}
          loading={false}
        />,
      );
      expect(html).toContain(`${label}</span>`);
      expect(html).toContain("View details");
      expect(html).toContain(explanation);
      expect(html).toContain("Not installed");
      expect(html).not.toContain("Ready to play");
      expect(html.match(/<button[^>]*class="port-card [^>]*>/u)?.[0]).not.toContain(" disabled=");
    },
  );

  it.each(["future-platform", "constructor", "__proto__", "toString"])(
    "renders explicit platform fallback for %s without manufacturing a selected channel",
    (value) => {
      const port = {
        ...portDefinition(),
        platforms: [value],
        support_tier: value,
      } as PortDefinition;
      const html = renderToStaticMarkup(
        <PortBrowser
          view="catalog"
          ports={[port]}
          statuses={new Map()}
          overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={vi.fn()}
          loading={false}
        />,
      );
      expect(html).toContain("Unknown platform");
      expect(html).not.toContain("Unknown channel");
      expect(html).not.toContain('class="badge unknown"');
      expect(html).not.toContain(`class="badge ${value}"`);
    },
  );

  it("preserves recognized platforms", () => {
    expect(platformLabel("windows-x86-64")).toBe("Windows");
    expect(platformLabel("linux-x86-64")).toBe("Linux");
    expect(platformLabel("macos-x86-64")).toBe("macOS Intel");
    expect(platformLabel("macos-aarch64")).toBe("Apple silicon");
  });

  it.each(["future-source", "constructor", "__proto__"])(
    "does not invent sign-in provenance for %s",
    (value) => {
      const html = renderToStaticMarkup(
        <SettingsView
          github={{
            status: {
              source: value as GithubAuthStatus["source"],
              authenticated: false,
              login: null,
              rate_limit: null,
              device_login_available: false,
            },
            token: "",
            setToken: vi.fn(),
            saveToken: vi.fn(),
            logout: vi.fn(),
            beginDeviceLogin: vi.fn(),
            refresh: vi.fn(),
          }}
        />,
      );
      expect(html).toContain("Sign-in source unavailable");
      expect(html).not.toContain("Operating-system credential store");
      expect(html).not.toContain("Environment variable");
    },
  );

  it.each([
    { channels: [], selected: "stable" },
    { channels: ["stable"], selected: "future" },
    { channels: ["stable", "constructor"], selected: "stable" },
    { channels: ["__proto__"], selected: "__proto__" },
  ])("does not offer an unrecognized or inconsistent channel selection: %j", (input) => {
    const change = vi.fn();
    const html = renderToStaticMarkup(
      <ReleaseChannelControl
        channels={input.channels as ReleaseChannel[]}
        selected={input.selected as ReleaseChannel}
        busy={false}
        change={change}
        refresh={vi.fn()}
      />,
    );
    expect(html).toContain("Selected channel:");
    expect(html).toContain("Your saved choice has not changed");
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(change).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not invent a size for %s bytes",
    (bytes) => {
      expect(formatBytes(bytes)).toBe("Size unknown");
    },
  );

  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1024, "1.0 KiB"],
    [1024 ** 4, "1.0 TiB"],
    [Number.MAX_SAFE_INTEGER, "8.0 PiB"],
  ] as const)("formats %s bytes with binary units", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([
    [0, 0],
    [100, -1],
    [100, 101],
    [NaN, 0],
    [Infinity, 1],
    [100, 0.5],
  ])("omits the meter for inconsistent capacity %s/%s", (total, available) => {
    const html = renderToStaticMarkup(
      <SettingsView
        storage={{
          library_root: "owned-library",
          volume_total_bytes: total,
          volume_available_bytes: available,
        }}
      />,
    );
    expect(html).toContain("Storage capacity is unavailable");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("width:NaN");
  });

  it("distinguishes a measured full drive from unavailable capacity", () => {
    const full = renderToStaticMarkup(
      <SettingsView
        storage={{
          library_root: "owned-library",
          volume_total_bytes: 1024,
          volume_available_bytes: 0,
        }}
      />,
    );
    expect(full).toContain("0 B available");
    expect(full).toContain('role="meter"');
    expect(full).toContain('aria-valuenow="0"');
    const unknown = renderToStaticMarkup(<SettingsView />);
    expect(unknown).toContain("Storage capacity is unavailable");
    expect(unknown).not.toContain('role="meter"');
  });
});

const cardInstall: NonNullable<PortStatus["active"]> = {
  id: "install",
  port_id: "sample",
  channel: "stable",
  version: "1",
  path: "/fixture",
  installed_at: 1,
  staged: false,
  verified: true,
  manifest_sha256: "a".repeat(64),
  selected_executable: "game.exe",
  runtime: null,
  artifact: { asset_name: "fixture.zip", size: 1, sha256: "a".repeat(64) },
};
it.each(["catalog", "library"] as const)(
  "presents installed input reasons on %s cards with reachable Details",
  (view) => {
    for (const [blocker, label, reason] of [
      ["missing_source", "Game files missing", "Required game files are missing"],
      ["changed_source", "Game files changed", "game files changed"],
      ["unreadable_source", "Game files unreadable", "cannot read the required game files"],
      ["missing_bios", "BIOS file missing", "BIOS file is missing"],
      ["changed_bios", "BIOS file changed", "BIOS file changed"],
      ["unreadable_bios", "BIOS file unreadable", "cannot read the required BIOS file"],
    ] as const) {
      const port = portDefinition();
      const status: PortStatus = {
        ...portStatus(),
        active: cardInstall,
        readiness: { launchable: false, pending_setup: false, blockers: [blocker] },
      };
      const html = renderToStaticMarkup(
        <PortBrowser
          view={view}
          ports={[port]}
          statuses={new Map([[port.id, status]])}
          overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={vi.fn()}
          onContinue={vi.fn()}
          loading={false}
        />,
      );
      expect(html).toContain(label);
      expect(html).toContain(reason);
      expect(html).toContain("aria-describedby=");
      expect(html).not.toContain(">Play</button>");
      expect(html).toContain(view === "library" ? `View details for ${port.name}` : "Finish setup");
    }
  },
);
it.each(["stable", "beta", "rolling"] as const)(
  "labels the selected Catalog release channel %s without deriving it from support",
  (channel) => {
    const port = { ...portDefinition(), support_tier: "rolling" as const };
    const status = { ...portStatus(), channel };
    const html = renderToStaticMarkup(
      <PortBrowser
        view="catalog"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(html).toContain(
      ` · ${channel === "beta" ? "Preview" : channel === "stable" ? "Stable" : "Rolling"} channel`,
    );
  },
);
