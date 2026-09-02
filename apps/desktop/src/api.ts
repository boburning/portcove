import { invoke } from "@tauri-apps/api/core";
import type { ActivityRecord, BackupRecord, CatalogDocument, DoctorReport, GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult, InstallPlan, InstallRecord, PortStatus, ReconcileOutcome, ReleaseChannel, RestoreResult, SourceRecord, SourceVerificationOutcome, UpdateCheck, UpdateCheckOutcome, UpdatePolicy } from "./types";

export const desktopApi = {
  githubAuthStatus: () => invoke<GithubAuthStatus>("get_github_auth_status"),
  setGithubToken: (token: string) => invoke<GithubAuthStatus>("set_github_token", { token }),
  logoutGithub: () => invoke<GithubAuthStatus>("logout_github"),
  beginGithubDeviceLogin: () => invoke<GithubDeviceLogin>("begin_github_device_login"),
  pollGithubDeviceLogin: (sessionId: string) => invoke<GithubDeviceLoginResult>("poll_github_device_login", { sessionId }),
  catalog: () => invoke<CatalogDocument>("get_catalog"),
  statuses: () => invoke<PortStatus[]>("get_statuses"),
  sources: () => invoke<SourceRecord[]>("get_sources"),
  activities: () => invoke<ActivityRecord[]>("get_activities"),
  backups: (portId: string) => invoke<BackupRecord[]>("get_backups", { portId }),
  backup: (portId: string) => invoke<BackupRecord>("create_backup", { portId }),
  restoreBackup: (portId: string, backupId: string) => invoke<RestoreResult>("restore_backup", { portId, backupId }),
  deleteBackup: (portId: string, backupId: string) => invoke<BackupRecord>("delete_backup", { portId, backupId }),
  addSource: (profileId: string, path: string) => invoke<SourceRecord>("add_source", { profileId, path }),
  verifySources: () => invoke<SourceVerificationOutcome[]>("verify_sources"),
  check: (portId: string) => invoke<UpdateCheck>("check_port", { portId }),
  checkInstalled: () => invoke<UpdateCheckOutcome[]>("check_installed"),
  reconcileInstalled: () => invoke<ReconcileOutcome[]>("reconcile_installed"),
  doctor: () => invoke<DoctorReport>("get_doctor_report"),
  plan: (portId: string, channel: ReleaseChannel) => invoke<InstallPlan>("plan_port", { portId, channel }),
  openUserData: (portId: string) => invoke<string>("open_user_data", { portId }),
  setChannel: (portId: string, channel: ReleaseChannel) => invoke<PortStatus>("set_channel", { portId, channel }),
  setPolicy: (portId: string, policy: UpdatePolicy) => invoke<PortStatus>("set_policy", { portId, policy }),
  install: (portId: string, channel: ReleaseChannel, source: string, bios: string, stage: boolean) =>
    invoke<InstallRecord>("install_port", { input: { portId, channel, source: source || null, bios: bios || null, stage } }),
  update: (portId: string, source: string, bios: string, stage: boolean) =>
    invoke<InstallRecord>("update_port", { portId, source: source || null, bios: bios || null, stage }),
  verify: (portId: string) => invoke("verify_port", { portId }),
  activate: (portId: string) => invoke("activate_port", { portId }),
  rollback: (portId: string) => invoke("rollback_port", { portId }),
  remove: (portId: string) => invoke<string[]>("remove_port", { portId }),
  launch: (portId: string, source: string) => invoke("launch_port", { portId, source: source || null, arguments: [] }),
  previewAdoption: (path: string, portId?: string) => invoke("preview_adoption", { path, portId: portId ?? null }),
  adopt: (path: string, portId?: string) => invoke("adopt_port", { path, portId: portId ?? null }),
};
