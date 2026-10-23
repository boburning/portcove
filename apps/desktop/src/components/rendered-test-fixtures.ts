import { portDefinition } from "../test-fixtures";
import { vi } from "vite-plus/test";
import type { InstallRecord, PortDefinition } from "../types";
import type { DetailActions } from "./DetailPanel";

export const port: PortDefinition = {
  ...portDefinition(),
  id: "sample",
  name: "Sample Port",
  summary: "A sample native port",
  project_url: "https://example.com",
  support_tier: "stable",
  channels: ["stable", "beta"],
  platforms: ["windows-x86-64"],
  adapter: "staged-source-portable",
  automated_tested_platforms: ["windows-x86-64"],
  manually_validated_platforms: [],
  source_profile: "sample-rom",
  persistent_paths: ["save"],
  upstream_status: "active",
  presentation: {
    installation_method: "staged-game-files",
    source_requirements: [
      {
        role: "game",
        profile_id: "sample-rom",
        label: "Sample cartridge",
        verification: "catalog-identity",
      },
    ],
    saves_and_settings: "portcove-managed",
  },
  release: portDefinition().release,
  executable_hints: {},
};
export const actions: DetailActions = {
  activate: vi.fn(),
  backup: vi.fn(),
  check: vi.fn(),
  close: vi.fn(),
  deleteBackup: vi.fn(),
  dismissInstallReview: vi.fn(),
  install: vi.fn(),
  launch: vi.fn(),
  openUserData: vi.fn(),
  reviewInstall: vi.fn(),
  remove: vi.fn(),
  restoreBackup: vi.fn(),
  rollback: vi.fn(),
  setChannel: vi.fn(),
  setPolicy: vi.fn(),
  verify: vi.fn(),
};

export const defaultNoticeProps = {
  updateNotice: undefined,
  updateChoiceRequired: false,
  productionTransitionRequired: false,
  productionTransitionBusy: false,
  reviewUpdate: vi.fn(),
  dismissUpdate: vi.fn().mockResolvedValue(undefined),
  dismissUpdateChoice: vi.fn(),
  useStable: vi.fn(),
  keepPreview: vi.fn(),
  dismissProductionTransition: vi.fn(),
};

export const installRecord = (overrides: Partial<InstallRecord> = {}): InstallRecord => ({
  id: "1",
  port_id: port.id,
  version: "1.0",
  path: "sample/1.0",
  channel: "stable",
  installed_at: 1,
  verified: true,
  staged: false,
  artifact: { asset_name: "sample.zip", sha256: "b".repeat(64), size: 1 },
  manifest_sha256: "c".repeat(64),
  selected_executable: "sample.exe",
  runtime: null,
  ...overrides,
});

export const bundledRuntime = {
  archive_root: "runtime",
  asset: {
    name: "runtime.zip",
    url: "https://example.com/runtime.zip",
    size: 1024,
    sha256: "d".repeat(64),
  },
  executable: "runtime.exe",
  target_directory: "runtime",
} satisfies NonNullable<PortDefinition["bundled_runtime"]["windows-x86-64"]>;

export const runtimeIdentity = {
  archive_root: bundledRuntime.archive_root,
  artifact: {
    asset_name: bundledRuntime.asset.name,
    sha256: bundledRuntime.asset.sha256,
    size: bundledRuntime.asset.size,
  },
  executable: bundledRuntime.executable,
  origin: "verified_download",
  target_directory: bundledRuntime.target_directory,
} satisfies NonNullable<InstallRecord["runtime"]>;
