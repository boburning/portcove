/** Public routing evidence only; never logs, keys, package data or acceptance. */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectReleaseControlPhase } from "./release-control-phases.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { errorCode, isRecord } from "./runtime-values.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { homedir } from "node:os";

export async function retainControllerDiagnostics(root: string, rawPhase: unknown) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (!path.isAbsolute(root)) throw new Error("owned diagnostics root required");
  const directory = path.join(root, `controller-public-evidence-${phase}`);
  await mkdir(directory, { mode: 0o700 }); // Preserve earlier attempt; no overwrite.
  const names = [
    `controller-${phase === "admission" ? "building" : phase}-source.json`,
    `controller-worker-${phase}-started.json`,
    `controller-job-settlement-${phase}.json`,
    `release-control-${phase}-process-ended.json`,
    ...[
      "clock",
      "aggregate-ack",
      "signature-ack",
      "context-ack",
      "result-ack",
      "site-ack",
      "attest-ack",
      "attestation-uploaded",
    ].map((suffix) => `controller-transport-${phase}-${suffix}.json`),
    ...Array.from(
      { length: 40 },
      (_, slot) => `controller-transport-${phase}-slot-${slot + 1}.json`,
    ),
    ...Array.from({ length: 15 }, (_, round) => `control-step-ready-${phase}-r${round}.json`),
  ];
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const unavailable: { path: string; reason: string }[] = [];
  for (const name of names) {
    try {
      const bytes = await readControllerToolFile(path.join(root, name), 65536);
      JSON.parse(bytes.toString("utf8"));
      await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
      files.push({
        path: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      unavailable.push({
        path: name,
        reason: errorCode(error) === "ENOENT" ? "absent" : "unreadable-or-invalid",
      });
    }
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      phase,
      files,
      unavailable,
      authority: "none",
      scope: "public-routing-diagnostics-only",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return directory;
}

/** Fixed public lifecycle rows only. Missing/partial rows stay unavailable;
 * collecting them neither retries nor settles the original native worker. */
export async function retainHostedNativeDiagnostics(
  temporary: string,
  home: string,
  run: string,
  revision: string,
  windows?: { platform: "windows-x86_64"; binding?: string },
) {
  if (
    !path.isAbsolute(temporary) ||
    !path.isAbsolute(home) ||
    !/^[1-9][0-9]{0,15}$/u.test(run) ||
    !/^[a-f0-9]{40}$/u.test(revision)
  )
    throw new Error("fixed native diagnostics binding required");
  if (
    windows &&
    (windows.platform !== "windows-x86_64" ||
      (windows.binding !== undefined && !/^[a-f0-9]{64}$/u.test(windows.binding)))
  )
    throw new Error("fixed Windows native diagnostics binding required");
  const source = windows
    ? windows.binding
      ? path.join(home, `.pcn-${windows.binding.slice(0, 32)}`)
      : undefined
    : path.join(home, `.portcove-native-${run}-1-${revision}`);
  const directory = path.join(
    temporary,
    windows ? "native-public-evidence-windows" : "native-public-evidence-linux",
  );
  await mkdir(directory, { mode: 0o700 });
  const names = windows
    ? [
        "native-supervision-started.json",
        "native-supervision-settlement.json",
        "native-supervision-settlement.json.complete.json",
        "portcove-native-job-clock.json",
        ...["pre-sign", "post-sign"].flatMap((stage) => [
          `windows-native-${stage}-stage.json`,
          `windows-native-${stage}-stage.json.complete.json`,
        ]),
      ]
    : [
        "native-supervision-started.json",
        "native-supervision-settlement.json",
        "native-supervision-refusal.json",
        "portcove-native-job-clock.json",
        "native-post-start.json",
        ...["pre-sign", "post-sign"].flatMap((stage) => [
          `${stage}-supervision-settlement.json`,
          `${stage}-supervision-refusal.json`,
          `${stage}-tree-cleanup.json`,
          ...["started", "refusal", "settlement", "upload-request", "upload-ack"].map(
            (suffix) => `portcove-native-linux-${stage}/native-job-${suffix}.json`,
          ),
        ]),
      ];
  if (windows && source) {
    for (const [stage, phase] of [
      ["pre-sign", "payload-signing"],
      ["post-sign", "release-publication"],
    ] as const) {
      try {
        const raw: unknown = JSON.parse(
          (
            await readBoundedPublicBuildInputFile(
              source,
              `windows-native-${stage}-stage.json`,
              8192,
            )
          ).toString("utf8"),
        );
        if (
          !isRecord(raw) ||
          raw.run_id !== run ||
          raw.revision !== revision ||
          raw.run_attempt !== 1 ||
          raw.platform !== "windows-x86_64" ||
          raw.stage !== stage ||
          typeof raw.directory !== "string" ||
          !new RegExp(
            `^hosted-native-parent-[A-Za-z0-9]{6}/windows-session/${phase}/capture$`,
            "u",
          ).test(raw.directory)
        )
          continue;
        const relative = raw.directory;
        names.push(
          ...["started", "refusal", "settlement", "upload-request", "upload-ack"].map(
            (suffix) => `${relative}/native-job-${suffix}.json`,
          ),
        );
      } catch {
        /* Unavailable routes never select other directories. Fixed rows remain observable below. */
      }
    }
  }
  const records = names.map((name) => ({ root: source, name, source: name }));
  if (windows)
    records.push(
      ...["start", "started", "refusal"].map((suffix) => ({
        root: temporary,
        name: `portcove-native-windows-workflow-${suffix}.json`,
        source: `temporary:portcove-native-windows-workflow-${suffix}.json`,
      })),
    );
  const files: { path: string; source: string; bytes: number; sha256: string }[] = [];
  const unavailable: { path: string; reason: string }[] = [];
  for (const [index, record] of records.entries()) {
    try {
      if (!record.root) throw new Error("original Windows routing binding unavailable");
      const bytes = windows
        ? await readBoundedPublicBuildInputFile(record.root, record.name, 65536)
        : await readControllerToolFile(path.join(record.root, record.name), 65536);
      JSON.parse(bytes.toString("utf8"));
      const output = `record-${index}.json`;
      await writeFile(path.join(directory, output), bytes, { flag: "wx", mode: 0o600 });
      files.push({
        path: output,
        source: record.source,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      unavailable.push({
        path: record.source,
        reason: errorCode(error) === "ENOENT" ? "absent" : "unreadable-or-invalid",
      });
    }
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      run_id: run,
      run_attempt: 1,
      controller_revision: revision,
      ...(windows ? { platform: windows.platform, binding: windows.binding ?? null } : {}),
      files,
      unavailable,
      scope: "public-native-routing-diagnostics-only",
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  if (process.argv[2] === "native-windows" && process.argv.length === 3) {
    const temporary = process.env.RUNNER_TEMP ?? "";
    let binding: string | undefined;
    try {
      const raw: unknown = JSON.parse(
        (
          await readBoundedPublicBuildInputFile(
            temporary,
            "portcove-native-windows-workflow-start.json",
            8192,
          )
        ).toString("utf8"),
      );
      if (
        isRecord(raw) &&
        raw.platform === "windows-x86_64" &&
        raw.authority === "none" &&
        raw.schema_version === 1 &&
        typeof raw.binding === "string" &&
        /^[a-f0-9]{64}$/u.test(raw.binding)
      )
        binding = raw.binding;
    } catch {
      /* Collection cannot reconstruct missing authority or retry an attempt. */
    }
    await retainHostedNativeDiagnostics(
      temporary,
      homedir(),
      process.env.GITHUB_RUN_ID ?? "",
      process.env.GITHUB_SHA ?? "",
      { platform: "windows-x86_64", ...(binding === undefined ? {} : { binding }) },
    );
  } else if (process.argv[2] === "native-linux" && process.argv.length === 3)
    await retainHostedNativeDiagnostics(
      process.env.RUNNER_TEMP ?? "",
      process.env.HOME ?? "",
      process.env.GITHUB_RUN_ID ?? "",
      process.env.GITHUB_SHA ?? "",
    );
  else await retainControllerDiagnostics(process.env.RUNNER_TEMP ?? "", process.argv[2]);
