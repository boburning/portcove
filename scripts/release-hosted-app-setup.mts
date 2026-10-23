import { performance } from "node:perf_hooks";
import type { GitHubRestReader } from "./github-api.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

export type HostedReleaseAppRole = "semantic" | "protection_observer";
function rolePermissions(role: HostedReleaseAppRole) {
  if (role !== "semantic" && role !== "protection_observer")
    throw new Error("unselected hosted App role");
  return role === "semantic"
    ? { checks: "write", metadata: "read" }
    : { administration: "write", metadata: "read" };
}

/** Credential-free registration data only. The observer really requests Admin
 * WRITE; GET-only implementation does not reduce that credential's authority.
 * Neither generating this manifest nor reading an App appoints a producer. */
export function prepareHostedReleaseAppManifest(role: HostedReleaseAppRole) {
  const permissions = rolePermissions(role);
  return {
    name:
      role === "semantic"
        ? "Portcove Independent Semantic Producer"
        : "Portcove Protection Observer",
    url: "https://github.com/boburning/portcove",
    public: false,
    hook_attributes: { url: "https://github.com/boburning/portcove", active: false },
    redirect_url: `http://127.0.0.1:1456/portcove-app-setup/${role}`,
    default_permissions: permissions,
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  };
}

function providerId(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("hosted App measured provider identity unavailable");
}

/** Verify one already provisioned role using its separate App-authenticated and
 * installation-authenticated GET clients. No token acquisition, default CLI
 * credential, mutation, semantic acceptance or candidate authority is supplied.
 * This returns a public allowlist, never an unchecked provider response. */
export function observeHostedReleaseApp(
  role: HostedReleaseAppRole,
  expected: { app_id: number; installation_id: number },
  clients: { app: GitHubRestReader; installation: GitHubRestReader },
) {
  const selected = { ...expected };
  providerId(selected.app_id);
  providerId(selected.installation_id);
  if (selected.app_id === 15368) throw new Error("generic Actions cannot be a selected App");
  const permissions = rolePermissions(role);
  const started = performance.now();
  const get = (client: GitHubRestReader, endpoint: string) => {
    if (performance.now() - started > 30_000) throw new Error("hosted App readback expired");
    const response = client.request("GET", endpoint);
    if (
      response.status !== 200 ||
      response.headers.get("link") ||
      performance.now() - started > 30_000 ||
      Buffer.byteLength(JSON.stringify(response.body) ?? "") > 128 * 1024
    )
      throw new Error("hosted App readback unavailable, incomplete, oversized or late");
    return response.body;
  };
  const app = get(clients.app, "app");
  const installation = get(clients.app, `app/installations/${selected.installation_id}`);
  const repositories = get(clients.installation, "installation/repositories?per_page=100");
  const exactPermissions = (value: unknown) =>
    isRecord(value) && releaseCanonicalDigest(value) === releaseCanonicalDigest(permissions);
  const noEvents = (value: unknown) => Array.isArray(value) && value.length === 0;
  if (
    !isRecord(app) ||
    app.id !== selected.app_id ||
    !isRecord(app.owner) ||
    app.owner.id !== 43177418 ||
    app.owner.login !== "boburning" ||
    !exactPermissions(app.permissions) ||
    !noEvents(app.events) ||
    !isRecord(installation) ||
    installation.id !== selected.installation_id ||
    installation.app_id !== selected.app_id ||
    !isRecord(installation.account) ||
    installation.account.id !== 43177418 ||
    installation.account.login !== "boburning" ||
    installation.suspended_at !== null ||
    installation.repository_selection !== "selected" ||
    !exactPermissions(installation.permissions) ||
    !noEvents(installation.events) ||
    !isRecord(repositories) ||
    repositories.total_count !== 1 ||
    !Array.isArray(repositories.repositories) ||
    repositories.repositories.length !== 1 ||
    !isRecord(repositories.repositories[0]) ||
    repositories.repositories[0].id !== 1354613114 ||
    repositories.repositories[0].full_name !== "boburning/portcove"
  )
    throw new Error("hosted App owner, identity, permission or repository boundary differs");
  return {
    role,
    ...selected,
    repository_id: 1354613114 as const,
    owner_id: 43177418 as const,
    permissions,
    authority: "none" as const,
    acceptance: "not-established" as const,
  };
}

/** Distinct measured App and installation identities are mandatory. Job-token
 * roles have no entry here and must pass their own actual fixed-job verifier. */
export function inspectHostedReleaseAppSeparation(
  semantic: ReturnType<typeof observeHostedReleaseApp>,
  observer: ReturnType<typeof observeHostedReleaseApp>,
) {
  if (
    semantic.role !== "semantic" ||
    observer.role !== "protection_observer" ||
    semantic.app_id === observer.app_id ||
    semantic.installation_id === observer.installation_id
  )
    throw new Error("hosted App roles are conflated");
  return { semantic: structuredClone(semantic), protection_observer: structuredClone(observer) };
}
