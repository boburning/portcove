import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULES = {
  "portcove-core": {
    forbidden: {
      tauri: "portcove-core must remain independent of presentation-layer dependencies.",
      clap: "portcove-core must remain independent of command-line presentation dependencies.",
      "tracing-subscriber": "Host tracing subscribers and rotation belong in adapters; core returns structured failure reports and shared redaction.",
      "portcove-cli": "portcove-core cannot depend on an adapter that consumes it.",
      "portcove-desktop": "portcove-core cannot depend on an adapter that consumes it.",
      "portcove-release-tools": "Repository release verification is not game-management authority.",
    },
  },
  "portcove-cli": {
    required: ["portcove-core"],
    forbidden: {
      image: "Artwork validation, decoding and thumbnail policy belong to portcove-core.",
      "ed25519-dalek": "Catalog signature verification and trust policy belong to portcove-core.",
      tauri: "CLI behavior belongs behind portcove-core APIs, not Tauri.",
      "portcove-desktop": "The CLI and desktop are peer adapters and must not depend on each other.",
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
      "portcove-release-tools": "Application runtime verification uses its host verifier, not repository tooling.",
    },
  },
  "portcove-release-tools": {
    forbidden: {
      "portcove-core": "Offline application artifact verification must not open or mutate game libraries.",
      "portcove-cli": "Repository release tooling cannot invoke the player CLI as a domain authority.",
      "portcove-desktop": "Repository release verification must remain independent of the GUI runtime.",
      tauri: "Offline verification does not require a desktop runtime.",
      "ed25519-dalek": "Release tooling cannot become a parallel catalog signing authority.",
    },
  },
};

export function validateArchitecture(metadata, rules = RULES) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]));
  const violations = [];

  const namesById = new Map(metadata.packages.map(pkg => [pkg.id, pkg.name]));
  const defaultMembers = (metadata.workspace_default_members ?? []).map(id => namesById.get(id) ?? id).sort();
  const expectedDefaultMembers = ["portcove-cli", "portcove-core"];
  if (JSON.stringify(defaultMembers) !== JSON.stringify(expectedDefaultMembers)) {
    violations.push({
      packageName: "workspace default-members",
      dependencyName: null,
      message: "Cargo default-members must remain exactly portcove-core and portcove-cli so the default Rust build stays independent of the desktop frontend toolchain.",
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

export function formatViolations(violations) {
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

function loadMetadata() {
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
