import { readFileSync, readdirSync, readlinkSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "./runtime-values.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import path from "node:path";

function linuxProcesses() {
  const names = readdirSync("/proc").filter((name) => /^\d+$/u.test(name));
  const rows = [];
  let unavailable = 0;
  for (const name of names.slice(0, 4096)) {
    try {
      const root = "/proc/" + name;
      if (lstatSync(root).uid !== process.getuid?.()) continue;
      const io = Object.fromEntries(
        readFileSync(root + "/io", "utf8")
          .trim()
          .split("\n")
          .map((line): [string, number] => {
            const [field, value] = line.split(":");
            const number = Number(value);
            if (!field || !Number.isFinite(number) || number < 0)
              throw new Error("Invalid process I/O counter");
            return [field, number];
          }),
      );
      rows.push({
        pid: Number(name),
        identity: readProcessIdentity(Number(name)),
        executable: path.basename(readlinkSync(root + "/exe")),
        workspace: readlinkSync(root + "/cwd"),
        read_bytes: io.read_bytes ?? 0,
        write_bytes: io.write_bytes ?? 0,
        cancelled_write_bytes: io.cancelled_write_bytes ?? 0,
        registration: "unobserved",
      });
    } catch {
      unavailable++;
    }
  }
  rows.sort(
    (left, right) => right.read_bytes + right.write_bytes - left.read_bytes - left.write_bytes,
  );
  return {
    observed: rows.length,
    unavailable,
    inventory_truncated: names.length > 4096,
    rows: rows.slice(0, 16),
    limits:
      "Top 16 observed same-user Linux processes by cumulative storage bytes, including waited-for children, not rates. Registration is not inferred; compare exact identities with lease records. Windows and inaccessible processes are outside this inventory.",
  };
}

export function parsePressure(text: string) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const [kind, ...fields] = line.split(/\s+/u);
        if (kind !== "some" && kind !== "full") throw new Error("Invalid pressure kind");
        const values = Object.fromEntries(
          fields.map((field) => {
            const [name, raw] = field.split("=");
            const value = Number(raw);
            if (!name || raw === undefined || !Number.isFinite(value) || value < 0)
              throw new Error("Invalid pressure value");
            return [name, value];
          }),
        );
        for (const field of ["avg10", "avg60", "avg300", "total"])
          if (!(field in values)) throw new Error("Incomplete pressure observation");
        return [kind, values];
      }),
  );
}

export function parseDiskStats(text: string) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 14) throw new Error("Incomplete disk observation");
      const numbers = fields.slice(3).map(Number);
      if (numbers.some((value) => !Number.isFinite(value) || value < 0))
        throw new Error("Invalid disk observation");
      return {
        device: fields[2],
        reads: numbers[0],
        read_sectors: numbers[2],
        read_ms: numbers[3],
        writes: numbers[4],
        write_sectors: numbers[6],
        write_ms: numbers[7],
        in_flight: numbers[8],
        busy_ms: numbers[9],
        weighted_queue_ms: numbers[10],
      };
    });
}

export function collectHostObservation() {
  const base = {
    observed_at: new Date().toISOString(),
    platform: process.platform,
    cpu_count: os.availableParallelism(),
    load_average: os.loadavg(),
    memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
  };
  try {
    if (process.platform === "linux")
      return {
        ...base,
        observation: "recorded" as const,
        io_pressure: parsePressure(readFileSync("/proc/pressure/io", "utf8")),
        memory_pressure: parsePressure(readFileSync("/proc/pressure/memory", "utf8")),
        cpu_pressure: parsePressure(readFileSync("/proc/pressure/cpu", "utf8")),
        disk_counters: parseDiskStats(readFileSync("/proc/diskstats", "utf8")),
        processes: linuxProcesses(),
        limits:
          "Kernel-wide observations; virtual block devices do not identify their physical backing media.",
      };
    if (process.platform === "win32") {
      const script =
        "$ErrorActionPreference='Stop'; [ordered]@{ activity=@((Get-Counter -Counter '\\PhysicalDisk(*)\\Avg. Disk sec/Read','\\PhysicalDisk(*)\\Avg. Disk sec/Write','\\PhysicalDisk(*)\\Avg. Disk Queue Length','\\PhysicalDisk(*)\\Disk Bytes/sec' -MaxSamples 1).CounterSamples | Select-Object Path,CookedValue,Status,Timestamp) } | ConvertTo-Json -Depth 5 -Compress";
      const raw = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 32 * 1024,
          windowsHide: true,
        },
      );
      return {
        ...base,
        observation: "recorded" as const,
        storage: JSON.parse(raw) as unknown,
        limits:
          "Read-only Windows counters; unavailable probes and unregistered workloads remain unknown.",
      };
    }
    return {
      ...base,
      observation: "unavailable" as const,
      reason: "I/O sampling is supported on Windows and Linux",
    };
  } catch (error) {
    return {
      ...base,
      observation: "unavailable" as const,
      reason: errorMessage(error).slice(0, 512),
    };
  }
}

export async function sampleHostObservations(seconds = 0, signal?: AbortSignal) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 60)
    throw new Error("Sample duration must be an integer from 0 to 60 seconds");
  const started = performance.now();
  const samples = [collectHostObservation()];
  while (performance.now() - started < seconds * 1000) {
    await delay(
      Math.min(1000, Math.max(1, seconds * 1000 - (performance.now() - started))),
      undefined,
      { signal },
    );
    samples.push(collectHostObservation());
  }
  return { elapsed_ms: Math.round(performance.now() - started), samples };
}
