/** Opt-in public tool qualification only. No key, vault, credential installation,
 * signing or publication operation exists here. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { inspectRecoveryToolTar } from "./recovery-tool-archive.mts";
import { parseAquaConfig, validateAquaChecksumLedger } from "./aqua-integrity.mts";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const recoveryToolPins = Object.freeze({
  aqua: {
    version: "2.64.0",
    source: "954fd59f789f69445ddb13903721de8b9e9a05b2",
    url: "https://github.com/aquaproj/aqua/releases/download/v2.64.0/aqua_linux_amd64.tar.gz",
    bytes: 9701961,
    sha256: "b276e927ee2f4dc214831708c0843a91007bafa06f2f9fcd6ee1fd73fd165598",
  },
  age: {
    version: "1.3.2",
    source: "b74dce4cdbe35b5e5f66c06d9612b72f89028758",
    url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz",
    bytes: 19405817,
    sha256: "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10",
    workflow: "FiloSottile/age/.github/workflows/build.yml",
  },
  // Exact checksum/version inventory embedded by the already-pinned Aqua build.
  gh: {
    version: "2.102.0",
    bytes: 15319960,
    url: "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_amd64.tar.gz",
    sha256: "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386",
  },
});

export function inspectRecoveryAttestation(raw: unknown, expectedDigest: string) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16)
    throw new Error("bounded verified attestation results required");
  const statements = raw.map((result: unknown) => {
    if (
      !isRecord(result) ||
      !isRecord(result.verificationResult) ||
      !isRecord(result.verificationResult.statement)
    )
      throw new Error("verified statement unavailable");
    const statement = result.verificationResult.statement;
    if (
      statement.predicateType !== "https://slsa.dev/provenance/v1" ||
      !Array.isArray(statement.subject) ||
      statement.subject.length < 1 ||
      statement.subject.length > 16 ||
      !isRecord(statement.predicate) ||
      !isRecord(statement.predicate.buildDefinition)
    )
      throw new Error("attestation subject or provenance differs");
    const matching = statement.subject.filter(
      (subject: unknown) =>
        isRecord(subject) &&
        subject.name === "age-v1.3.2-linux-amd64.tar.gz" &&
        isRecord(subject.digest) &&
        subject.digest.sha256 === expectedDigest,
    );
    if (
      matching.length !== 1 ||
      new Set(
        statement.subject.map((subject: unknown) => (isRecord(subject) ? subject.name : null)),
      ).size !== statement.subject.length
    )
      throw new Error("attestation exact subject missing or duplicated");
    const build = statement.predicate.buildDefinition;
    if (
      !isRecord(build.externalParameters) ||
      !isRecord(build.externalParameters.workflow) ||
      build.externalParameters.workflow.repository !== "https://github.com/FiloSottile/age" ||
      build.externalParameters.workflow.path !== ".github/workflows/build.yml" ||
      build.externalParameters.workflow.ref !== "refs/tags/v1.3.2" ||
      !Array.isArray(build.resolvedDependencies) ||
      !build.resolvedDependencies.some(
        (value: unknown) =>
          isRecord(value) &&
          isRecord(value.digest) &&
          value.digest.gitCommit === recoveryToolPins.age.source &&
          typeof value.uri === "string" &&
          value.uri.startsWith("git+https://github.com/FiloSottile/age@"),
      )
    )
      throw new Error("attested producer or source differs");
    return statement;
  });
  return {
    subject_sha256: expectedDigest,
    source: recoveryToolPins.age.source,
    workflow: recoveryToolPins.age.workflow,
    statements: statements.length,
  };
}

async function privateDirectory(directory: string) {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  )
    throw new Error("owned private canonical recovery tool directory required");
}
async function regular(filename: string, maximum = 64 * 1024 ** 2) {
  const stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    stat.size < 1 ||
    stat.size > maximum ||
    (await realpath(filename)) !== filename
  )
    throw new Error("bounded owned recovery tool file required");
  const bytes = await readControllerToolFile(filename, maximum, stat);
  const after = await lstat(filename);
  if (
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.uid !== stat.uid ||
    after.nlink !== 1 ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ctimeMs !== stat.ctimeMs ||
    after.mode !== stat.mode ||
    (await realpath(filename)) !== filename
  )
    throw new Error("recovery tool pathname changed during bounded acquisition");
  return bytes;
}
async function download(pin: { url: string; bytes: number; sha256: string }, deadline: number) {
  const signal = AbortSignal.timeout(
    Math.max(1, Math.min(90000, Math.floor(deadline - performance.now()))),
  );
  let url = pin.url;
  for (let redirects = 0; redirects <= 1; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location") ?? "", url);
      if (
        redirects !== 0 ||
        next.protocol !== "https:" ||
        next.hostname !== "release-assets.githubusercontent.com" ||
        next.username ||
        next.password
      )
        throw new Error("recovery tool redirect refused");
      url = next.href;
      continue;
    }
    if (response.status !== 200 || !response.body)
      throw new Error("recovery tool public download unavailable");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const raw of response.body) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new Error("recovery tool stream representation");
      bytes += chunk.byteLength;
      if (bytes > pin.bytes) throw new Error("recovery tool download byte bound");
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks);
    if (result.length !== pin.bytes || sha(result) !== pin.sha256)
      throw new Error("recovery tool independently pinned bytes differ");
    return result;
  }
  throw new Error("recovery tool redirect limit");
}

/** Integrity-only cache inspection; supplied pins confer no tool or signing authority.
 * The actual bootstrap always supplies its fixed source appointments. */
export async function verifyRecoveryToolFiles(
  directory: string,
  tools: { path: string; sha256: string }[],
  pins: Record<"aqua" | "gh" | "age", { bytes: number; sha256: string }>,
) {
  if (tools.length !== 4) throw new Error("complete Aqua/verifier/age/keygen inventory required");
  const requirements = [
    ["aqua", "aqua", tools[0]],
    ["gh", "gh_2.102.0_linux_amd64/bin/gh", tools[1]],
    ["age", "age/age", tools[2]],
    ["age", "age/age-keygen", tools[3]],
  ] as const;
  for (const [kind, member, tool] of requirements) {
    const archive = await regular(path.join(directory, `${kind}.tar.gz`));
    if (archive.length !== pins[kind].bytes || sha(archive) !== pins[kind].sha256)
      throw new Error("recovery archive changed from independent pin");
    const content = inspectRecoveryToolTar(archive, kind).get(member);
    if (
      !content ||
      !tool ||
      !tool.path.startsWith(`${directory}/`) ||
      sha(await regular(tool.path)) !== sha(content) ||
      tool.sha256 !== sha(content)
    )
      throw new Error("recovery tool cache corruption or substitution");
  }
}

export async function inspectRecoveryToolProof(
  directory: string,
  expectedHash: string,
  archiveHash: string,
) {
  const proof = await regular(path.join(directory, "verified-attestation.stdout"), 4 * 1024 ** 2);
  if (sha(proof) !== expectedHash) throw new Error("cached attestation changed");
  return inspectRecoveryAttestation(JSON.parse(proof.toString("utf8")), archiveHash);
}

/** Linux x64 opt-in bootstrap; other hosts refuse before effects. Ordinary
 * frontend/native bootstraps never call this path or install this profile. */
export async function prepareRecoveryTools(parent: string) {
  if (process.platform !== "linux" || process.arch !== "x64" || !path.isAbsolute(parent))
    throw new Error("recovery tool bootstrap currently requires Linux x64 private parent");
  parent = path.resolve(parent);
  await privateDirectory(parent);
  const configPath = path.join(root, ".config/recovery-tools/aqua.yaml");
  const config = await readFile(configPath, "utf8");
  const ledger = await readFile(path.join(path.dirname(configPath), "aqua-checksums.json"));
  const parsed = parseAquaConfig(config);
  if ((await readFile(path.join(root, ".aqua-version"), "utf8")).trim() !== "v2.64.0")
    throw new Error("recovery bootstrap requires reconciliation with pinned Aqua version");
  if (
    parsed.registryRef !== "v4.564.0" ||
    JSON.stringify(parsed.packages) !==
      JSON.stringify([
        { name: "FiloSottile/age", version: "v1.3.2" },
        { name: "cli/cli", version: "v2.102.0" },
      ])
  )
    throw new Error("recovery-only fixed package appointment differs");
  const entries = validateAquaChecksumLedger(parsed, JSON.parse(ledger.toString("utf8")));
  for (const [name, pin] of [
    ["FiloSottile/age", recoveryToolPins.age],
    ["cli/cli", recoveryToolPins.gh],
  ] as const) {
    const entry = entries.find(
      (entry) =>
        entry.id ===
        `github_release/github.com/${name}/v${pin.version}/${new URL(pin.url).pathname.split("/").at(-1)}`,
    );
    if (entry?.checksum.toLowerCase() !== pin.sha256)
      throw new Error("recovery ledger differs from source-appointed archive");
  }
  const fingerprint = sha(
    `${config}\0${ledger.toString("utf8")}\0${JSON.stringify(recoveryToolPins)}`,
  );
  const directory = path.join(parent, `recovery-tools-${fingerprint}`);
  const deadline = performance.now() + 600000;
  const receiptPath = path.join(directory, "receipt.json");
  const command = async (
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    label: string,
    maximumMilliseconds: number,
  ) => {
    const left = Math.floor(deadline - performance.now());
    if (left < 1) throw new Error("recovery tool original deadline expired");
    const result = await run(executable, args, {
      cwd: directory,
      env,
      timeout: Math.min(left, maximumMilliseconds),
      maxBuffer: 4 * 1024 ** 2,
    });
    await writeFile(path.join(directory, `${label}.stdout`), result.stdout, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, `${label}.stderr`), result.stderr, {
      flag: "wx",
      mode: 0o600,
    });
    return result.stdout;
  };
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    await privateDirectory(directory);
    const receipt: unknown = JSON.parse((await regular(receiptPath, 64 * 1024)).toString("utf8"));
    if (
      !isRecord(receipt) ||
      receipt.fingerprint !== fingerprint ||
      !Array.isArray(receipt.tools) ||
      receipt.tools.length !== 4
    )
      throw new Error("partial or changed recovery tool cache; retain original attempt");
    const tools: { path: string; sha256: string }[] = [];
    for (const item of receipt.tools) {
      if (
        !isRecord(item) ||
        typeof item.path !== "string" ||
        typeof item.sha256 !== "string" ||
        !item.path.startsWith(`${directory}/`) ||
        sha(await regular(item.path)) !== item.sha256
      )
        throw new Error("recovery tool cache corruption or substitution");
      tools.push({ path: item.path, sha256: item.sha256 });
    }
    await verifyRecoveryToolFiles(directory, tools, recoveryToolPins);
    if (typeof receipt.attestation_sha256 !== "string")
      throw new Error("cached attestation identity absent");
    await inspectRecoveryToolProof(
      directory,
      receipt.attestation_sha256,
      recoveryToolPins.age.sha256,
    );
    return { directory, reused: true, receipt };
  }
  try {
    const aquaArchive = await download(recoveryToolPins.aqua, deadline);
    await writeFile(path.join(directory, "aqua.tar.gz"), aquaArchive, { flag: "wx", mode: 0o600 });
    const aquaFiles = inspectRecoveryToolTar(aquaArchive, "aqua");
    const aqua = path.join(directory, "aqua");
    await writeFile(aqua, aquaFiles.get("aqua")!, { flag: "wx", mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GH_HOST: "github.com",
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      AQUA_ROOT_DIR: path.join(directory, "aqua-root"),
      AQUA_ENFORCE_CHECKSUM: "true",
      AQUA_ENFORCE_REQUIRE_CHECKSUM: "true",
      AQUA_MAX_PARALLELISM: "1",
      // Staging only: Aqua can silently skip auth failures and retry verification.
      // The mandatory direct source-bound verifier below is the sole acceptance gate.
      AQUA_DISABLE_GITHUB_ARTIFACT_ATTESTATION: "true",
    };
    if (
      (await command(aqua, ["--version"], env, "aqua-version", 10000)).trim() !==
      "aqua version 2.64.0"
    )
      throw new Error("pinned Aqua version differs");
    await command(aqua, ["-c", configPath, "install"], env, "aqua-install", 450000);
    const locate = async (name: string) => {
      const filename = (
        await command(aqua, ["-c", configPath, "which", name], env, `which-${name}`, 10000)
      ).trim();
      if (!filename.startsWith(`${env.AQUA_ROOT_DIR}/`))
        throw new Error("recovery tool escaped managed root");
      await regular(filename);
      return filename;
    };
    const gh = await locate("gh"),
      age = await locate("age"),
      keygen = await locate("age-keygen");
    const ghArchive = await download(recoveryToolPins.gh, deadline);
    await writeFile(path.join(directory, "gh.tar.gz"), ghArchive, { flag: "wx", mode: 0o600 });
    if (
      sha(await regular(gh)) !==
      sha(inspectRecoveryToolTar(ghArchive, "gh").get("gh_2.102.0_linux_amd64/bin/gh")!)
    )
      throw new Error("managed verifier differs from independently pinned Aqua companion archive");
    const ghVersion = await command(gh, ["--version"], env, "gh-version", 10000);
    if (!ghVersion.startsWith("gh version 2.102.0 "))
      throw new Error("pinned verifier version differs");
    const archive = await download(recoveryToolPins.age, deadline);
    const archivePath = path.join(directory, "age.tar.gz");
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    delete env.AQUA_DISABLE_GITHUB_ARTIFACT_ATTESTATION;
    const verified = await command(
      gh,
      [
        "attestation",
        "verify",
        archivePath,
        "--repo",
        "FiloSottile/age",
        "--signer-workflow",
        recoveryToolPins.age.workflow,
        "--source-digest",
        recoveryToolPins.age.source,
        "--source-ref",
        "refs/tags/v1.3.2",
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--format",
        "json",
      ],
      env,
      "verified-attestation",
      90000,
    );
    const attestation = inspectRecoveryAttestation(
      JSON.parse(verified),
      recoveryToolPins.age.sha256,
    );
    const members = inspectRecoveryToolTar(archive, "age");
    if (
      sha(await regular(age)) !== sha(members.get("age/age")!) ||
      sha(await regular(keygen)) !== sha(members.get("age/age-keygen")!)
    )
      throw new Error("installed recovery tools differ from attested archive");
    if (
      (await command(age, ["--version"], env, "age-version", 10000)).trim() !== "v1.3.2" ||
      (await command(keygen, ["--version"], env, "age-keygen-version", 10000)).trim() !== "v1.3.2"
    )
      throw new Error("recovery tools version differs");
    const tools = await Promise.all(
      [aqua, gh, age, keygen].map(async (filename) => ({
        path: filename,
        sha256: sha(await regular(filename)),
      })),
    );
    await verifyRecoveryToolFiles(directory, tools, recoveryToolPins);
    const receipt = {
      schema_version: 1,
      fingerprint,
      pins: recoveryToolPins,
      tools,
      attestation,
      attestation_sha256: sha(verified),
      authority: "public-recovery-tools-only",
      automatic_retry: false,
      elapsed_milliseconds: Math.ceil(600000 - (deadline - performance.now())),
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return { directory, reused: false, receipt };
  } catch (error) {
    await writeFile(
      path.join(directory, "failure.json"),
      JSON.stringify({
        stage: "public-tool-qualification",
        automatic_retry: false,
        result: "not-qualified",
        detail: error instanceof Error ? error.message.slice(0, 1024) : "unknown failure",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--prepare")
    throw new Error("usage: prepare-recovery-tools.mts --prepare PRIVATE_PARENT (Linux x64)");
  const { resourceEntrypoint } = await import("./resource-command.mts");
  process.exitCode = await resourceEntrypoint(
    "analysis",
    async () => {
      console.log(JSON.stringify(await prepareRecoveryTools(process.argv[3]!)));
      return 0;
    },
    { executionTimeoutMilliseconds: 650000 },
  );
}
