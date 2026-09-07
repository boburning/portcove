import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./windows-qualification-session.ps1", import.meta.url));
const installerLifecycleTool = fileURLToPath(new URL("./test-windows-installer.ps1", import.meta.url));

test("installer lifecycle journals every required process before spawning it", () => {
  const source = readFileSync(installerLifecycleTool, "utf8");
  for (const role of ["predecessor_installer", "predecessor_smoke", "candidate_installer", "candidate_smoke", "candidate_uninstaller"]) assert.match(source, new RegExp(`"${role}"`));
  const pending = source.indexOf('status = "launch_pending"');
  const write = source.indexOf("Write-InstallerEvidence $evidence.phase", pending);
  const spawnIndex = source.indexOf("Start-Process -FilePath $exact", pending);
  assert.ok(pending >= 0 && write > pending && spawnIndex > write);
  for (const field of ["executable_path", "executable_sha256", "pid", "start_time_filetime", "exit_observation"]) assert.match(source, new RegExp(field));
  assert.match(source, /AllowedRelocationRoot/);
  assert.match(source, /process relocated outside its owned temporary root/);
  assert.match(source, /process bytes do not match its write-ahead record/);
  assert.match(source, /retained handle does not identify the exact requested launch path/);
  assert.match(source, /stable executable image path could not be observed/);
  assert.match(source, /Process exited before a stable executable image path was observable/);
  assert.match(source, /-Role "predecessor_installer".*-AllowedRelocationRoot \$runRoot/);
  assert.match(source, /-Role "candidate_installer".*-AllowedRelocationRoot \$runRoot/);
  assert.match(source, /-Role "candidate_uninstaller".*-AllowedRelocationRoot \$runRoot/);
  assert.match(source, /RetainedLibraryRoot must be an isolated sibling below the TestBase parent/);
  assert.match(source, /RetainedLibraryRoot must be empty before qualification/);
  assert.match(source, /\$requested\.Equals\(\$base, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(readFileSync(script, "utf8"), /RetainedLibraryRoot = Resolve-ContainedPath \$root \$session\.paths\.library "Directory"/);
  assert.match(readFileSync(script, "utf8"), /Abort retained handle does not identify the journaled launch path/);
  assert.match(readFileSync(script, "utf8"), /Cannot observe a stable abort executable image path/);
});
