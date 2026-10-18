import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isRecord, errorCode } from "./runtime-values.mts";

const unavailable = "Private IGDB credentials are unavailable or invalid.";
export const maintainerConfigPath = () => path.join(homedir(), ".portcove", "maintainer.json");

// Read at most limit+1 bytes from one descriptor, including a growing input.
function boundedJson(file: string, limit: number): unknown {
  const fd = openSync(file, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      bytes += count;
      if (bytes > limit) throw new Error();
      if (!count) break;
    }
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

export function readIgdbCredentials(file: string | null | undefined) {
  try {
    if (!file) throw new Error();
    const value = boundedJson(file, 64 * 1024);
    if (
      !isRecord(value) ||
      typeof value.client_id !== "string" ||
      !value.client_id ||
      typeof value.client_secret !== "string" ||
      !value.client_secret
    )
      throw new Error();
    return { client_id: value.client_id, client_secret: value.client_secret };
  } catch {
    throw new Error(unavailable);
  }
}

export function resolveIgdbCredentialsFile(
  explicit?: string | null,
  config = maintainerConfigPath(),
): string | undefined {
  if (explicit !== undefined && explicit !== null) return explicit;
  try {
    const value = boundedJson(config, 16 * 1024);
    if (
      !isRecord(value) ||
      value.format_version !== 1 ||
      JSON.stringify(Object.keys(value).sort()) !== '["format_version","igdb_credentials_file"]' ||
      typeof value.igdb_credentials_file !== "string" ||
      !path.isAbsolute(value.igdb_credentials_file)
    )
      throw new Error();
    return value.igdb_credentials_file;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error("Maintainer path configuration is unavailable or invalid.");
  }
}

export function setIgdbCredentialsFile(file: string, config = maintainerConfigPath()) {
  try {
    if (!path.isAbsolute(file)) throw new Error();
    readIgdbCredentials(file);
    // Refuse to replace unknown local configuration or secret-bearing fields.
    resolveIgdbCredentialsFile(undefined, config);
    const bytes = `${JSON.stringify({ format_version: 1, igdb_credentials_file: path.normalize(file) }, null, 2)}\n`;
    mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(config), `.maintainer-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temporary, config);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the write outcome and any owned temporary that could not be removed.
      }
    }
    return { configured: true, valid: true };
  } catch {
    throw new Error(
      "Maintainer path configuration could not be saved; credentials must be an existing valid absolute file.",
    );
  }
}

export function checkIgdbCredentialsFile(config = maintainerConfigPath()) {
  let configured = false;
  try {
    const file = resolveIgdbCredentialsFile(undefined, config);
    configured = file !== undefined;
    if (!file)
      return { configured: false, available: false, valid: false, reason: "not-configured" };
    readIgdbCredentials(file);
    return { configured, available: true, valid: true };
  } catch {
    return { configured, available: false, valid: false, reason: "unavailable-or-invalid" };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, file, ...rest] = process.argv.slice(2);
    if (command === "set-igdb-credentials-file" && file && !rest.length)
      console.log(JSON.stringify(setIgdbCredentialsFile(file)));
    else if (command === "check" && file === undefined) {
      const result = checkIgdbCredentialsFile();
      console.log(JSON.stringify(result));
      process.exitCode = result.valid ? 0 : 1;
    } else throw new Error("usage: maintainer-config.mts set-igdb-credentials-file ABS | check");
  } catch {
    console.error(
      "Maintainer path configuration command failed. Use set-igdb-credentials-file ABS or check; no network access is performed.",
    );
    process.exitCode = 1;
  }
}
