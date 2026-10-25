/** Qualification keeps its original Core build scope, profile and ordered phases. */
export const qualificationCoreScope = ["--locked", "-p", "portcove-core"] as const;
export const qualificationCoreProfile = "default";

export interface QualificationCorePhase {
  name: string;
  arguments: string[];
}
export interface QualificationCoreWorker {
  name: string;
  phases: QualificationCorePhase[];
}
export interface QualificationCoreWorkerInventory {
  name: string;
  phases: (QualificationCorePhase & { tests: string[] })[];
}

export function qualificationCoreWorkers(): QualificationCoreWorker[] {
  const phase = (name: string, args: string[]): QualificationCorePhase => ({
    name,
    arguments: [...qualificationCoreScope, ...args],
  });
  const other = (partition: string) => [
    "--partition",
    partition,
    "--",
    "--skip",
    "service::",
    "--skip",
    "cancellation::",
    "--skip",
    "database::",
    "--skip",
    "import_execution::",
    "--skip",
    "library_move::",
  ];
  return [
    {
      name: "core-service-1",
      phases: [phase("service", ["--partition", "hash:1/2", "service::"])],
    },
    {
      name: "core-service-2",
      phases: [phase("service", ["--partition", "hash:2/2", "service::"])],
    },
    {
      name: "core-recovery",
      phases: [
        phase("cancellation", ["cancellation::"]),
        phase("database", ["database::"]),
        phase("import_execution", ["import_execution::"]),
        phase("library_move", ["library_move::"]),
      ],
    },
    { name: "core-other-1", phases: [phase("other", other("hash:1/2"))] },
    { name: "core-other-2", phases: [phase("other", other("hash:2/2"))] },
  ];
}

export function reusedQualificationArguments(phase: QualificationCorePhase) {
  if (!qualificationCoreScope.every((arg, index) => phase.arguments[index] === arg))
    throw new Error("Qualification Core build scope differs");
  // Reused metadata already names exactly this package. Cargo build flags cannot
  // be sent to nextest's reuse mode; the remaining selectors stay verbatim.
  return phase.arguments.slice(qualificationCoreScope.length);
}

export function nextestListArguments(args: string[]) {
  const delimiter = args.indexOf("--");
  const end = delimiter < 0 ? args.length : delimiter;
  return [...args.slice(0, end), "--message-format", "json", ...args.slice(end)];
}
