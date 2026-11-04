import { isRecord } from "./runtime-values.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";

type Step = { title: string; instruction: string };
export interface RouteFactsV1 {
  format_version: 1;
  prepared_player: {
    executable?: string;
    working_directory: "executable-parent";
    arguments: string[];
    data_locations: string[];
  };
  managed_native?: { preparation: Step; warnings: string[] };
}

// Presentation authoring only. Concrete existing Core contracts still own every
// operation. No paragraph is parsed into executable or data authority.
export const registrationOwnership =
  "Portcove records the selected executable, working folder and literal arguments after review. Play is separate and only the selected process is supervised. You and upstream own replacement and updates; relink changed executable bytes after reviewing them. Removing this registration preserves every external file. Managed installation, backup, rollback, migration and deletion are not offered for this external copy.";
export const managedOwnership =
  "Portcove installs and replaces its separate official runtime using the declared release rules. Existing external registrations retain their files and user/upstream ownership. Runtime rollback carries current declared data; it does not rewind saves or establish older-runtime compatibility. Gameplay and populated-save compatibility remain separate qualification.";

function text(value: unknown, maximum = 4096): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value) > maximum
  )
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some((key) => !names.includes(key)))
    throw new Error("Unknown route fact; author an explicit supported route contract.");
}
function strings(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => text(item)) &&
    new Set(value).size === value.length
  );
}
function playerExecutable(
  player: Record<string, unknown>,
  integration?: Record<string, unknown>,
): unknown {
  if (player.executable !== undefined) return player.executable;
  const hints = isRecord(integration?.executable_hints)
    ? integration.executable_hints["windows-x86-64"]
    : undefined;
  return Array.isArray(hints) && hints.length === 1 ? hints[0] : undefined;
}
function resolvedPlayer(facts: RouteFactsV1, integration?: Record<string, unknown>) {
  const executable = playerExecutable(facts.prepared_player, integration);
  if (!text(executable, 160)) throw new Error("Route has no unique concrete player executable.");
  return { ...facts.prepared_player, executable };
}
export function checkRouteFacts(
  value: unknown,
  integration?: Record<string, unknown>,
): asserts value is RouteFactsV1 {
  if (!isRecord(value) || value.format_version !== 1 || !isRecord(value.prepared_player))
    throw new Error("Route facts require version 1 and a prepared player.");
  fields(value, ["format_version", "prepared_player", "managed_native"]);
  const player = value.prepared_player;
  fields(player, ["executable", "working_directory", "arguments", "data_locations"]);
  const executable = playerExecutable(player, integration);
  if (
    !text(executable, 160) ||
    /[\\/:]/u.test(executable) ||
    !executable.toLowerCase().endsWith(".exe") ||
    executable === ".exe" ||
    player.working_directory !== "executable-parent" ||
    !strings(player.arguments, 32) ||
    !strings(player.data_locations, 32) ||
    player.data_locations.length === 0
  )
    throw new Error(
      "Prepared-player facts need a bounded Windows basename, executable-parent folder, literal arguments and data locations.",
    );
  if (value.managed_native !== undefined) {
    const managed = value.managed_native;
    if (!isRecord(managed) || !isRecord(managed.preparation))
      throw new Error("Managed native facts need an explicit preparation action.");
    fields(managed, ["preparation", "warnings"]);
    fields(managed.preparation, ["title", "instruction"]);
    if (
      !text(managed.preparation.title, 256) ||
      !text(managed.preparation.instruction) ||
      !strings(managed.warnings, 16) ||
      integration?.adapter !== "native-portable" ||
      !isRecord(integration.release) ||
      integration.release.provider !== "github" ||
      !Array.isArray(integration.persistent_paths) ||
      integration.source_profile != null
    )
      throw new Error(
        "Managed native facts require an existing source-free native-portable GitHub contract and bounded preparation/warnings.",
      );
    if (
      !isRecord(integration.executable_hints) ||
      !Array.isArray(integration.executable_hints["windows-x86-64"]) ||
      !integration.executable_hints["windows-x86-64"].includes(executable)
    )
      throw new Error("Managed executable facts disagree with the operational declaration.");
  } else if (integration !== undefined)
    throw new Error("A managed declaration needs its explicit managed route facts.");
}

export function projectRouteFacts(record: AuthoredPort): AuthoredPort {
  if (record.route_facts_v1 === undefined) return record;
  checkRouteFacts(record.route_facts_v1, record.integration);
  const facts = record.route_facts_v1;
  const projected = structuredClone(record);
  const guide = projected.listing.manual_setup;
  if (
    !isRecord(guide) ||
    !Array.isArray(guide.steps) ||
    !Array.isArray(guide.warnings) ||
    (guide.references !== undefined && !Array.isArray(guide.references))
  )
    throw new Error("Route facts require a concrete bespoke guide envelope.");
  const player = resolvedPlayer(facts, record.integration);
  const selector: Step = {
    title: "Select the prepared player",
    instruction: `Select ${player.executable} and use its containing folder as the working directory. ${player.arguments.length ? `Enter these literal argument values in order, one array item per argument: ${JSON.stringify(player.arguments)}.` : "Leave arguments empty."} Keep the complete independently permitted runtime and finish the title-specific preparation before Play.`,
  };
  const steps: unknown[] = guide.steps;
  const warnings: unknown[] = guide.warnings;
  const references: unknown[] = guide.references ?? [];
  guide.steps = [
    ...(facts.managed_native ? [facts.managed_native.preparation] : []),
    ...steps,
    selector,
  ];
  guide.warnings = [...warnings, ...(facts.managed_native?.warnings ?? [])];
  guide.references = [
    ...references,
    { title: "Registration ownership and removal", instruction: registrationOwnership },
    {
      title: "Player-data ownership",
      instruction: `You and upstream own the external copy's data: ${player.data_locations.join("; ")}. Back up these locations separately; registration does not migrate or certify their compatibility.`,
    },
  ];
  if (facts.managed_native) {
    const integration = projected.integration!;
    const preservation = `Portcove preserves only these declared local inputs during replacement and backup: ${(integration.persistent_paths as string[]).join(", ")}. Its backup does not include external profiles.`;
    (guide.references as unknown[]).push({
      title: "Managed runtime ownership",
      instruction: `${managedOwnership} ${preservation}`,
    });
    const presentation = isRecord(integration.presentation) ? integration.presentation : {};
    presentation.manual_preparation = [
      facts.managed_native.preparation.instruction,
      managedOwnership,
      preservation,
      ...facts.managed_native.warnings,
    ].join(" ");
    integration.presentation = presentation;
  }
  return projected;
}

export function routeEnrollment(records: readonly AuthoredPort[]) {
  return {
    format_version: 1,
    cases: records
      .filter((record) => record.route_facts_v1 !== undefined)
      .map((record) => {
        checkRouteFacts(record.route_facts_v1, record.integration);
        return {
          port_id: record.listing.id,
          prepared_player: resolvedPlayer(record.route_facts_v1, record.integration),
          managed_native: record.route_facts_v1.managed_native !== undefined,
        };
      })
      .sort((a, b) => a.port_id.localeCompare(b.port_id, "en")),
  };
}

/** Checked test-source artifacts, never runtime definitions or authored Rust. */
export function renderRouteTests(records: readonly AuthoredPort[]) {
  const cases = routeEnrollment(records).cases;
  if (cases.length > 256) throw new Error("Route test enrollment exceeds its finite bound.");
  if (new Set(cases.map((row) => row.port_id)).size !== cases.length)
    throw new Error("Duplicate generated route test identity.");
  const names = new Set<string>();
  function render(managed: boolean) {
    const selected = cases.filter((row) => row.managed_native === managed);
    const constant = managed
      ? "DECLARED_MANAGED_ROUTE_TEST_IDS"
      : "DECLARED_PREPARED_ROUTE_TEST_IDS";
    const values = selected.map((row) => JSON.stringify(row.port_id));
    const start = `const ${constant}: &[&str] = &`;
    const inline = `${start}[${values.join(", ")}];`;
    const inventory =
      inline.length <= 100
        ? inline
        : `${start}[\n${values.map((value) => `    ${value},`).join("\n")}\n];`;
    const wrappers = selected.map((row) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.port_id))
        throw new Error("Route test IDs must be stable safe literals.");
      const name = `${managed ? "managed_native_declared_" : "prepared_guide_adoption_declared_"}${row.port_id.replaceAll("-", "_")}`;
      if (names.has(name)) throw new Error("Duplicate generated route test identity.");
      names.add(name);
      return managed
        ? `#[tokio::test]\nasync fn ${name}() {\n    assert_declarative_managed_native_route(${JSON.stringify(row.port_id)}).await;\n}`
        : `#[test]\nfn ${name}() {\n    assert_declarative_prepared_player_route(${JSON.stringify(row.port_id)});\n}`;
    });
    return `// Generated by scripts/generate-catalog.mts from route facts.\n// Actual independent expectations and lifecycle assertions live in the shared harness.\n${inventory}\n\n${wrappers.join("\n\n")}\n`;
  }
  return { prepared: render(false), managed: render(true) };
}
