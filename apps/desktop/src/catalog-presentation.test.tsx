import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./components/Chrome";
import { PortBrowser } from "./components/PortBrowser";
import { ReleaseChannelControl } from "./components/ReleaseChannel";
import { portDefinition } from "./test-fixtures";
import type { GithubAuthStatus, PortDefinition, ReleaseChannel } from "./types";
import { formatBytes, platformLabel } from "./view-model";

describe("catalog and capacity presentation", () => {
  it.each(["future-platform", "constructor", "__proto__", "toString"])("renders explicit fallback for %s without treating it as a supported channel", value => {
    const port = { ...portDefinition(), platforms: [value], support_tier: value } as PortDefinition;
    const html = renderToStaticMarkup(<PortBrowser view="catalog" ports={[port]} statuses={new Map()} overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
      filter="all" setFilter={vi.fn()} onSelect={vi.fn()} loading={false} />);
    expect(html).toContain("Unknown platform");
    expect(html).toContain("Unknown channel");
    expect(html).toContain('class="badge unknown"');
    expect(html).not.toContain(`class="badge ${value}"`);
  });

  it("preserves recognized platforms", () => {
    expect(platformLabel("windows-x86-64")).toBe("Windows");
    expect(platformLabel("linux-x86-64")).toBe("Linux");
    expect(platformLabel("macos-x86-64")).toBe("macOS Intel");
    expect(platformLabel("macos-aarch64")).toBe("Apple silicon");
  });

  it.each(["future-source", "constructor", "__proto__"])("does not invent sign-in provenance for %s", value => {
    const html = renderToStaticMarkup(<SettingsView github={{
      status: { source: value as GithubAuthStatus["source"], authenticated: false, login: null, rate_limit: null, device_login_available: false },
      token: "", setToken: vi.fn(), saveToken: vi.fn(), logout: vi.fn(), beginDeviceLogin: vi.fn(), refresh: vi.fn(),
    }} />);
    expect(html).toContain("Sign-in source unavailable");
    expect(html).not.toContain("Operating-system credential store");
    expect(html).not.toContain("Environment variable");
  });

  it.each([
    { channels: [], selected: "stable" },
    { channels: ["stable"], selected: "future" },
    { channels: ["stable", "constructor"], selected: "stable" },
    { channels: ["__proto__"], selected: "__proto__" },
  ])("does not offer an unrecognized or inconsistent channel selection: %j", input => {
    const change = vi.fn();
    const html = renderToStaticMarkup(<ReleaseChannelControl channels={input.channels as ReleaseChannel[]} selected={input.selected as ReleaseChannel} busy={false} change={change} refresh={vi.fn()} />);
    expect(html).toContain("Release channel information is unavailable");
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(change).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])("does not invent a size for %s bytes", bytes => {
    expect(formatBytes(bytes)).toBe("Size unknown");
  });

  it.each([[0, "0 B"], [1, "1 B"], [1024, "1.0 KiB"], [1024 ** 4, "1.0 TiB"], [Number.MAX_SAFE_INTEGER, "8.0 PiB"]] as const)("formats %s bytes with binary units", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([[0, 0], [100, -1], [100, 101], [NaN, 0], [Infinity, 1], [100, 0.5]])("omits the meter for inconsistent capacity %s/%s", (total, available) => {
    const html = renderToStaticMarkup(<SettingsView storage={{ library_root: "owned-library", volume_total_bytes: total, volume_available_bytes: available }} />);
    expect(html).toContain("Storage capacity is unavailable");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("width:NaN");
  });

  it("distinguishes a measured full drive from unavailable capacity", () => {
    const full = renderToStaticMarkup(<SettingsView storage={{ library_root: "owned-library", volume_total_bytes: 1024, volume_available_bytes: 0 }} />);
    expect(full).toContain("0 B available");
    expect(full).toContain('role="meter"');
    expect(full).toContain('aria-valuenow="0"');
    const unknown = renderToStaticMarkup(<SettingsView />);
    expect(unknown).toContain("Storage capacity is unavailable");
    expect(unknown).not.toContain('role="meter"');
  });
});
