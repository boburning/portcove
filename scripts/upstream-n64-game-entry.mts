import { isRecord } from "./runtime-values.mts";

export const n64GameTablePath = "src/main/main.cpp";
const maximumGames = 64;
const nativeId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const hash = /^[a-f0-9]{16}$/u;

export interface N64GameEntry {
  game_id: string;
  mod_game_id: string | null;
  rom_hash_u64: string;
}

export function checkN64GameEntries(value: unknown): N64GameEntry[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > maximumGames) return;
  const entries: N64GameEntry[] = [];
  const gameIds = new Set<string>();
  for (const entry of value as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.game_id !== "string" ||
      !nativeId.test(entry.game_id) ||
      gameIds.has(entry.game_id) ||
      !(
        entry.mod_game_id === null ||
        (typeof entry.mod_game_id === "string" && nativeId.test(entry.mod_game_id))
      ) ||
      typeof entry.rom_hash_u64 !== "string" ||
      !hash.test(entry.rom_hash_u64)
    )
      return;
    gameIds.add(entry.game_id);
    entries.push({
      game_id: entry.game_id,
      mod_game_id: entry.mod_game_id,
      rom_hash_u64: entry.rom_hash_u64,
    });
  }
  return entries;
}

// Strip comments as whitespace before recognizing directives. Keep quoted
// tokens intact so their punctuation cannot appear in a game declaration.
const commentOrQuoted =
  /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|(?:u8|u|U|L)?R"|"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'/gu;
const cppToken =
  /^[ \t\v\f]*(?:#|%:)[^\r\n]*|(?:u8|u|U|L)?"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[A-Za-z_\d]+|::|%:|[^\s]/gmu;
const table = [
  "std",
  "::",
  "vector",
  "<",
  "recomp",
  "::",
  "GameEntry",
  ">",
  "supported_games",
  "=",
  "{",
];

function unclear(): never {
  throw new Error("N64 Recomp source has an unsupported or ambiguous game table");
}

function literalId(tokens: string[], prefix: string) {
  if (tokens.length !== 1) return unclear();
  const value = tokens[0]!;
  if (!value.startsWith(prefix + '"') || !value.endsWith('"')) return unclear();
  return value.slice(prefix.length + 1, -1);
}

function parseEntry(tokens: string[], start: number) {
  let end = start + 1;
  const fields = new Map<string, string[]>();
  while (tokens[end] !== "}") {
    if (tokens[end] !== "." || !tokens[end + 1] || tokens[end + 2] !== "=") return unclear();
    const field = tokens[end + 1]!;
    if (fields.has(field)) return unclear();
    const begin = (end += 3);
    const delimiters: string[] = [];
    while (end < tokens.length) {
      const token = tokens[end]!;
      if (!delimiters.length && (token === "," || token === "}")) break;
      if (token.startsWith("#")) return unclear();
      if (token === "(" || token === "[" || token === "{") {
        delimiters.push(token === "(" ? ")" : token === "[" ? "]" : "}");
      } else if ((token === ")" || token === "]" || token === "}") && delimiters.pop() !== token) {
        return unclear();
      }
      end++;
    }
    if (begin === end || end === tokens.length) return unclear();
    fields.set(field, tokens.slice(begin, end));
    if (tokens[end] === ",") end++;
  }
  const rom = fields.get("rom_hash");
  const hash = rom?.length === 1 && /^0x([a-fA-F0-9]{1,16})(?:ULL|ull)?$/u.exec(rom[0]!);
  if (!hash) return unclear();
  const mod = fields.get("mod_game_id");
  return {
    end,
    game: {
      game_id: literalId(fields.get("game_id") ?? [], "u8"),
      mod_game_id: mod ? literalId(mod, "") || null : null,
      rom_hash_u64: hash[1]!.toLowerCase().padStart(16, "0"),
    },
  };
}

/** Lex the bounded source without interpreting macros or directives. */
export function n64CppTokens(source: string): string[] {
  if (/\\[ \t\v\f]*(?:\r\n|\r|\n)/u.test(source)) return unclear();
  const withoutComments = source.replace(commentOrQuoted, (token) => {
    if (/^(?:u8|u|U|L)?R"$/u.test(token)) return unclear();
    if (token.startsWith("//")) return " ";
    if (!token.startsWith("/*")) return token;
    if (!token.endsWith("*/")) return unclear();
    return token.replace(/[^\r\n]/gu, " ");
  });
  return Array.from(withoutComments.matchAll(cppToken), (match) => {
    const token = match[0].trim().replace(/^%:/u, "#");
    if (token === "#" || token === '"') return unclear();
    return token;
  });
}

/** Extract source declarations only. No compiled-platform or acceptance claim. */
export function parseN64GameTable(source: string): N64GameEntry[] {
  const tokens = n64CppTokens(source);
  let conditionals = 0;
  let start: number | undefined;
  for (const [index, token] of tokens.entries()) {
    if (/^#\s*(?:if|ifdef|ifndef)\b/u.test(token)) conditionals++;
    if (/^#\s*endif\b/u.test(token) && --conditionals < 0) return unclear();
    if (
      index + 1 >= table.length &&
      table.every((part, i) => part === tokens[index + 1 - table.length + i])
    ) {
      if (conditionals !== 0 || start !== undefined) return unclear();
      start = index + 1;
    }
  }
  if (start === undefined || conditionals !== 0) return unclear();
  const games: N64GameEntry[] = [];
  let cursor = start;
  while (tokens[cursor] === "{") {
    if (games.length >= maximumGames) return unclear();
    const { end, game } = parseEntry(tokens, cursor);
    games.push(game);
    cursor = end + 1;
    if (tokens[cursor] !== ",") break;
    cursor++;
  }
  if (tokens[cursor] !== "}" || tokens[cursor + 1] !== ";") return unclear();
  return checkN64GameEntries(games) ?? unclear();
}
