import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULES = {
  "portcove-core": {
    forbidden: {
      tauri: "portcove-core must remain independent of presentation-layer dependencies.",
      clap: "portcove-core must remain independent of command-line presentation dependencies.",
      "portcove-cli": "portcove-core cannot depend on an adapter that consumes it.",
      "portcove-desktop": "portcove-core cannot depend on an adapter that consumes it.",
    },
  },
  "portcove-cli": {
    required: ["portcove-core"],
    forbidden: {
      "ed25519-dalek": "Catalog signature verification and trust policy belong to portcove-core.",
      tauri: "CLI behavior belongs behind portcove-core APIs, not Tauri.",
      "portcove-desktop": "The CLI and desktop are peer adapters and must not depend on each other.",
    },
  },
  "portcove-desktop": {
    required: ["portcove-core", "tauri"],
    forbidden: {
      "ed25519-dalek": "Catalog signature verification and trust policy belong to portcove-core.",
      clap: "Desktop commands should call portcove-core directly rather than parse CLI arguments.",
      "portcove-cli": "The desktop and CLI are peer adapters and must not depend on each other.",
    },
  },
};

export function validateArchitecture(metadata, rules = RULES) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]));
  const violations = [];

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
