import type { StageIdentity } from "./validation-evidence.mts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export interface AuditStage extends StageIdentity {
  reusable: boolean;
  platforms?: readonly string[];
  reason?: string;
}

export const AUDIT_STAGES: readonly AuditStage[] = Object.freeze([
  { id: "fallow", recipe: "fallow", domain: "ui", reusable: false },
  { id: "frontend-static", recipe: "ui-static", domain: "format", reusable: false },
  { id: "rust", recipe: "check-rust", domain: "rust", reusable: true },
  { id: "ui", recipe: "ui-runtime", domain: "ui", reusable: false },
  { id: "script-lint", recipe: "script-lint", domain: "lint", reusable: true },
  {
    id: "repository-tooling",
    recipe: "repository-tools",
    domain: "repository",
    reusable: true,
  },
  { id: "roadmap", recipe: "roadmap-check", domain: "roadmap", reusable: true },
  {
    id: "development-tools",
    recipe: "development-tools",
    domain: "development",
    reusable: true,
  },
  {
    id: "dependency-policy",
    recipe: "deny",
    domain: "rust",
    reusable: false,
    reason: "dependency and advisory state is externally mutable",
  },
  { id: "rscheck", recipe: "rscheck", domain: "rscheck", reusable: true },
  {
    id: "release-unit",
    recipe: "release-check",
    domain: "release",
    reusable: true,
  },
  {
    id: "windows-qualification",
    recipe: "windows-qualification-check",
    domain: "release",
    reusable: false,
    platforms: ["win32"],
    reason: "packaged Windows and machine-global state must be observed each audit",
  },
]);

export function hostedAuditIdentity(root = projectRoot) {
  const identity = {
    repository: process.env.GITHUB_REPOSITORY,
    source: process.env.GITHUB_SHA,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowDigest: createHash("sha256")
      .update(readFileSync(path.join(root, ".github/workflows/deep-quality.yml")))
      .digest("hex"),
  };
  if (
    identity.repository !== "boburning/portcove" ||
    typeof identity.source !== "string" ||
    typeof identity.workflowSha !== "string" ||
    typeof identity.run !== "string" ||
    typeof identity.attempt !== "string" ||
    !/^[a-f0-9]{40}$/.test(identity.source) ||
    !/^[a-f0-9]{40}$/.test(identity.workflowSha) ||
    !/^[1-9][0-9]{0,12}$/.test(identity.run) ||
    !/^[1-9][0-9]{0,12}$/.test(identity.attempt)
  )
    throw new Error("Invalid hosted audit identity");
  return identity;
}
