import { isRecord } from "./runtime-values.mts";
interface ArchitectureRule {
  required?: readonly string[];
  forbidden?: Readonly<Record<string, string>>;
}
interface ArchitectureViolation {
  packageName: string;
  dependencyName: string | null;
  message: string;
  missing?: boolean;
}
interface WorkspacePackage {
  id: string;
  name: string;
  dependencies: { name: string }[];
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError("Cargo architecture metadata must contain text identities");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Cargo architecture metadata must contain objects");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Cargo architecture metadata must contain arrays");
  return value;
}
function architectureMetadata(value: unknown) {
  const raw = object(value);
  const packages: WorkspacePackage[] = array(raw.packages).map((value) => {
    const pkg = object(value);
    return {
      id: text(pkg.id),
      name: text(pkg.name),
      dependencies: array(pkg.dependencies).map((value) => ({ name: text(object(value).name) })),
    };
  });
  return {
    packages,
    workspace_default_members: array(raw.workspace_default_members ?? []).map(text),
  };
}
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULES: Readonly<Record<string, ArchitectureRule>> = {
  "portcove-core": {
    forbidden: {
      tauri: "portcove-core must remain independent of presentation-layer dependencies.",
      clap: "portcove-core must remain independent of command-line presentation dependencies.",
      "tracing-subscriber":
        "Host tracing subscribers and rotation belong in adapters; core returns structured failure reports and shared redaction.",
      "portcove-cli": "portcove-core cannot depend on an adapter that consumes it.",
      "portcove-desktop": "portcove-core cannot depend on an adapter that consumes it.",
      "portcove-diagnostics":
        "Core emits observations; host diagnostic writing cannot become a Core dependency.",
      "portcove-release-tools": "Repository release verification is not game-management authority.",
    },
  },
  "portcove-diagnostics": {
    required: ["portcove-core"],
    forbidden: {
      tauri: "Shared host diagnostics must remain usable without the desktop runtime.",
      clap: "Executable argument parsing remains in the CLI adapter.",
      "portcove-cli": "Shared diagnostics cannot depend on its CLI consumer.",
      "portcove-desktop": "Shared diagnostics cannot depend on its Desktop consumer.",
      "portcove-release-tools": "Host logging is independent of repository release tooling.",
    },
  },
  "portcove-cli": {
    required: ["portcove-core"],
    forbidden: {
      image: "Artwork validation, decoding and thumbnail policy belong to portcove-core.",
      "ed25519-dalek": "Catalog signature verification and trust policy belong to portcove-core.",
      tauri: "CLI behavior belongs behind portcove-core APIs, not Tauri.",
      "portcove-desktop":
        "The CLI and desktop are peer adapters and must not depend on each other.",
      "portcove-release-tools": "The player CLI must not depend on repository release tooling.",
    },
  },
  "portcove-desktop": {
    required: ["portcove-core", "tauri"],
    forbidden: {
      image: "Artwork validation, decoding and thumbnail policy belong to portcove-core.",
      "ed25519-dalek": "Catalog signature verification and trust policy belong to portcove-core.",
      clap: "Desktop commands should call portcove-core directly rather than parse CLI arguments.",
      "portcove-cli": "The desktop and CLI are peer adapters and must not depend on each other.",
      "portcove-release-tools":
        "Application runtime verification uses its host verifier, not repository tooling.",
    },
  },
  "portcove-release-tools": {
    forbidden: {
      "portcove-core":
        "Offline application artifact verification must not open or mutate game libraries.",
      "portcove-cli":
        "Repository release tooling cannot invoke the player CLI as a domain authority.",
      "portcove-desktop":
        "Repository release verification must remain independent of the GUI runtime.",
      tauri: "Offline verification does not require a desktop runtime.",
      "ed25519-dalek": "Release tooling cannot become a parallel catalog signing authority.",
    },
  },
};

export function validateArchitecture(
  value: unknown,
  rules: Readonly<Record<string, ArchitectureRule>> = RULES,
) {
  const metadata = architectureMetadata(value);
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]));
  const violations: ArchitectureViolation[] = [];

  const namesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg.name]));
  const defaultMembers = (metadata.workspace_default_members ?? [])
    .map((id) => namesById.get(id) ?? id)
    .sort();
  const expectedDefaultMembers = ["portcove-cli", "portcove-core"];
  if (JSON.stringify(defaultMembers) !== JSON.stringify(expectedDefaultMembers)) {
    violations.push({
      packageName: "workspace default-members",
      dependencyName: null,
      message:
        "Cargo default-members must remain exactly portcove-core and portcove-cli so the default Rust build stays independent of the desktop frontend toolchain.",
    });
  }

  for (const [packageName, rule] of Object.entries(rules)) {
    const pkg = packages.get(packageName);
    if (!pkg) {
      violations.push({
        packageName,
        dependencyName: null,
        message: `Required workspace package ${packageName} was not found in Cargo metadata.`,
      });
      continue;
    }

    const dependencies = new Set(pkg.dependencies.map((dependency) => dependency.name));
    for (const dependencyName of rule.required ?? []) {
      if (!dependencies.has(dependencyName)) {
        violations.push({
          packageName,
          dependencyName,
          missing: true,
          message: `${packageName} must depend on ${dependencyName} to preserve the adapter boundary.`,
        });
      }
    }

    for (const [dependencyName, message] of Object.entries(rule.forbidden ?? {})) {
      if (dependencies.has(dependencyName)) {
        violations.push({ packageName, dependencyName, message });
      }
    }
  }

  return violations;
}

export function formatViolations(violations: readonly ArchitectureViolation[]) {
  return violations
    .map((violation) => {
      const relation = violation.dependencyName
        ? `${violation.packageName} ${violation.missing ? "-/->" : "->"} ${violation.dependencyName}`
        : violation.packageName;
      return [
        "architecture violation:",
        `  ${relation}`,
        "",
        violation.message,
        violation.missing
          ? "Restore the expected dependency through the workspace dependency table."
          : "Move the behavior behind a core API and keep presentation integration in its adapter.",
      ].join("\n");
    })
    .join("\n\n");
}

function loadMetadata(): unknown {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const output = execFileSync(cargo, ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

export function main() {
  const violations = validateArchitecture(loadMetadata());
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exitCode = 1;
    return;
  }
  console.log("Rust architecture gate passed: core authority and adapter boundaries are intact.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
