/**
 * Game-data signals for upstream release packages (#5353).
 *
 * Under the rights basis in docs/CATALOG.md, a package that bundles original
 * game data keeps its download hold; fonts, icons, launcher art and
 * unlicensed code are recorded notes. These rules recognise concrete game-data
 * signals from an archive's entry list and a small byte head of selected
 * entries. They never execute anything and never decide compatibility; a
 * finding asks a person to review the release before its hold is decided.
 */

export interface PackageEntry {
  /** Archive-relative path using `/` separators. */
  path: string;
  size: number;
  /** Exact member name for extraction when it differs from `path`. */
  member?: string;
}

export interface ContentSignal {
  path: string;
  kind:
    | "rom-or-disc-image"
    | "original-executable"
    | "cartridge-header"
    | "console-bios"
    | "shader-cache";
  reason: string;
}

/** Bytes of each candidate entry the caller should read for magic checks. */
export const HEAD_BYTES = 0x9400;

/** Bump when a rule changes, so cached verdicts are recomputed. */
export const RULES_VERSION = 2;

const ROM_EXTENSIONS = new Map<string, string>([
  [".z64", "Nintendo 64 ROM image"],
  [".n64", "Nintendo 64 ROM image"],
  [".v64", "Nintendo 64 ROM image"],
  [".nds", "Nintendo DS ROM image"],
  [".gba", "Game Boy Advance ROM image"],
  [".gbc", "Game Boy Color ROM image"],
  [".gb", "Game Boy ROM image"],
  [".sfc", "SNES ROM image"],
  [".smc", "SNES ROM image"],
  [".nes", "NES ROM image"],
  [".iso", "disc image"],
  [".chd", "compressed disc image"],
  [".cso", "compressed disc image"],
  [".wbfs", "Wii disc image"],
  [".rvz", "GameCube or Wii disc image"],
  [".xiso", "Xbox disc image"],
  [".pbp", "PSP or PlayStation package"],
  [".gdi", "Dreamcast disc image"],
  [".cdi", "Dreamcast disc image"],
  [".gcm", "GameCube disc image"],
  [".gcz", "GameCube or Wii disc image"],
  [".wia", "GameCube or Wii disc image"],
  [".3ds", "Nintendo 3DS ROM image"],
  [".cia", "Nintendo 3DS package"],
  [".nsp", "Nintendo Switch package"],
  [".xci", "Nintendo Switch cartridge image"],
]);

const ORIGINAL_EXECUTABLE_EXTENSIONS = new Map<string, string>([
  [".xex", "Xbox 360 title executable"],
  [".xexp", "Xbox 360 title-update patch"],
  [".dol", "GameCube or Wii main executable"],
  [".xbe", "original Xbox executable"],
]);

// The 16-byte start of Nintendo's boot logo, shared by GBA and NDS cartridge
// headers (GBA at 0x04, NDS at 0xC0).
const NINTENDO_LOGO = Buffer.from("24ffae51699aa2213d84820a84e409ad", "hex");
// Game Boy and Game Boy Color header logo at 0x104.
const GAME_BOY_LOGO = Buffer.from("ceed6666cc0d000b", "hex");
const N64_MAGICS = ["80371240", "37804012", "40123780"].map((hex) => Buffer.from(hex, "hex"));

function extension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function startsWithAt(head: Buffer, offset: number, value: Buffer) {
  return (
    head.length >= offset + value.length &&
    head.subarray(offset, offset + value.length).equals(value)
  );
}

/**
 * Entries whose byte head the caller should read: small files without a
 * recognised code or asset extension, where a header or BIOS could hide.
 */
export function headCandidates(entries: readonly PackageEntry[]): PackageEntry[] {
  return entries.filter(
    (entry) =>
      entry.size > 0 &&
      entry.size <= 64 * 1024 * 1024 &&
      !/\.(dll|so(\.\d+)*|dylib|exe|png|jpe?g|svg|ico|icns|ttf|otf|txt|md|json|toml|ini|cfg|rml|rcss|html?|css|js|py|lua|glsl|hlsl|spv|wav|ogg|mp3|pdb|xml|yaml|yml|csv|po|license|notice)$/i.test(
        entry.path,
      ),
  );
}

/**
 * Signals for one package. `heads` maps entry paths to their first
 * `HEAD_BYTES` (or fewer); entries without a head are judged by name only.
 */
export function packageSignals(
  entries: readonly PackageEntry[],
  heads: ReadonlyMap<string, Buffer> = new Map(),
): ContentSignal[] {
  const signals: ContentSignal[] = [];
  for (const entry of entries) {
    const ext = extension(entry.path);
    const rom = ROM_EXTENSIONS.get(ext);
    if (rom && entry.size > 0) {
      signals.push({ path: entry.path, kind: "rom-or-disc-image", reason: `${rom} file` });
      continue;
    }
    const original = ORIGINAL_EXECUTABLE_EXTENSIONS.get(ext);
    if (original && entry.size > 0) {
      signals.push({ path: entry.path, kind: "original-executable", reason: original });
      continue;
    }
    const head = heads.get(entry.path);
    if (!head) continue;
    if (startsWithAt(head, 0xc0, NINTENDO_LOGO) || startsWithAt(head, 0x04, NINTENDO_LOGO))
      signals.push({
        path: entry.path,
        kind: "cartridge-header",
        reason: "contains Nintendo's cartridge boot logo",
      });
    else if (startsWithAt(head, 0x104, GAME_BOY_LOGO))
      signals.push({
        path: entry.path,
        kind: "cartridge-header",
        reason: "contains the Game Boy cartridge boot logo",
      });
    else if (N64_MAGICS.some((magic) => startsWithAt(head, 0, magic)))
      signals.push({
        path: entry.path,
        kind: "rom-or-disc-image",
        reason: "Nintendo 64 ROM header",
      });
    else if (startsWithAt(head, 0, Buffer.from("4e45531a", "hex")))
      signals.push({ path: entry.path, kind: "rom-or-disc-image", reason: "iNES ROM header" });
    else if (
      startsWithAt(head, 0x8001, Buffer.from("CD001")) ||
      startsWithAt(head, 0x9319, Buffer.from("CD001"))
    )
      signals.push({ path: entry.path, kind: "rom-or-disc-image", reason: "ISO 9660 disc image" });
    else if (startsWithAt(head, 0, Buffer.from("XEX2")))
      signals.push({
        path: entry.path,
        kind: "original-executable",
        reason: "Xbox 360 XEX executable",
      });
    else if (startsWithAt(head, 0, Buffer.from("XESH")))
      signals.push({ path: entry.path, kind: "shader-cache", reason: "Xenia shader storage" });
    else if (
      entry.size === 512 * 1024 &&
      head.includes(Buffer.from("Sony Computer Entertainment Inc.")) &&
      !head.includes(Buffer.from("OpenBios"))
    )
      signals.push({ path: entry.path, kind: "console-bios", reason: "PlayStation BIOS image" });
  }
  return signals;
}
