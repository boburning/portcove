import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";
import { n64CppTokens } from "./upstream-n64-game-entry.mts";

export const n64RuntimeRepository = "N64Recomp/N64ModernRuntime";
export const n64RuntimeRepositoryId = 802962241;
export const n64RuntimeLinkPath = "lib/N64ModernRuntime";
export const n64RuntimeInputPath = "librecomp/src/recomp.cpp";

const gitSha = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const inputBlockPattern = "n64modernruntime-padded-xxh3-call-sites-v1" as const;

const inputBlocks = [
  "std::u8string recomp::GameEntry::stored_filename() const {",
  "bool recomp::register_game(const recomp::GameEntry& entry) {",
  "bool check_hash(const std::vector<uint8_t>& rom_data, uint64_t expected_hash) {",
  "static std::vector<uint8_t> read_file(const std::filesystem::path& path) {",
  "bool write_file(const std::filesystem::path& path, const std::vector<uint8_t>& data) {",
  "bool check_stored_rom(const recomp::GameEntry& game_entry) {",
  "bool recomp::load_stored_rom(std::u8string& game_id) {",
  "const std::array<uint8_t, 4> first_rom_bytes {",
  "enum class ByteswapType {",
  "ByteswapType check_rom_start(const std::vector<uint8_t>& rom_data) {",
  "void byteswap_data(std::vector<uint8_t>& rom_data, size_t index_xor) {",
  "recomp::RomValidationError recomp::select_rom(const std::filesystem::path& rom_path, std::u8string& game_id) {",
].map(n64CppTokens);

// These are digests of the input-path C++ tokens, shared by runtime revisions
// across titles. Other code in the file may change without changing this proof.
const reviewedBlocks = new Set([
  // N64ModernRuntime df7e820 (Zelda64Recomp), 0bb76b0 (BM64Recomp).
  "0c7cf4bad35b597ac6fd332cb9110907bf28ab182ab4e526bec3e641f0e21dbc",
  // N64ModernRuntime ca568b6 (Banjo Recomp).
  "484f3d5f3035b5bdee36ce84342dd6a83d31a9398e7e583c0d89c42225f39411",
]);

export function n64RuntimeInputFingerprint(source: string) {
  let tokens: string[];
  try {
    tokens = n64CppTokens(source);
  } catch {
    return null;
  }
  let conditionals = 0;
  const depths = tokens.map((token) => {
    if (/^#\s*(?:if|ifdef|ifndef)\b/u.test(token)) conditionals++;
    if (/^#\s*endif\b/u.test(token)) conditionals--;
    return conditionals;
  });
  if (conditionals !== 0 || depths.some((depth) => depth < 0)) return null;

  const proof: string[][] = [];
  for (const prefix of inputBlocks) {
    let found: string[] | undefined;
    for (const [index, token] of tokens.entries()) {
      if (token !== prefix[0] || !prefix.every((part, offset) => tokens[index + offset] === part))
        continue;
      if (found || depths[index] !== 0) return null;
      let end = index + prefix.length;
      let braces = 1;
      while (end < tokens.length && braces !== 0) {
        const token = tokens[end++];
        if (token?.startsWith("#")) return null;
        if (token === "{") braces++;
        if (token === "}") braces--;
      }
      if (braces !== 0) return null;
      found = tokens.slice(index, end);
    }
    if (!found) return null;
    proof.push(found);
  }
  const used = new Set(proof.flat());
  for (const token of tokens) {
    const directive = /^#\s*(?:define|undef)\s+([A-Za-z_]\w*)/u.exec(token);
    if (directive?.[1] && used.has(directive[1])) return null;
  }
  return orderedJsonSha256(proof);
}

function matchInputBlocks(fingerprint: string | null) {
  return fingerprint !== null && reviewedBlocks.has(fingerprint) ? inputBlockPattern : null;
}

export function n64RuntimeLinkRevision(value: unknown) {
  if (
    !isRecord(value) ||
    value.path !== n64RuntimeLinkPath ||
    value.type !== "submodule" ||
    typeof value.sha !== "string" ||
    !gitSha.test(value.sha) ||
    !(
      value.submodule_git_url === `https://github.com/${n64RuntimeRepository}` ||
      value.submodule_git_url === `https://github.com/${n64RuntimeRepository}.git`
    ) ||
    value.git_url !== `https://api.github.com/repos/${n64RuntimeRepository}/git/trees/${value.sha}`
  )
    return null;
  return value.sha;
}

interface N64RuntimeSourceEvidence {
  repository: typeof n64RuntimeRepository;
  repository_id: typeof n64RuntimeRepositoryId;
  source_path: typeof n64RuntimeInputPath;
  revision: string;
  blob_sha1: string;
  source_sha256: string;
  input_blocks_sha256: string | null;
  matched_input_blocks: typeof inputBlockPattern | null;
}

export type N64RuntimeSourceObservation =
  | { state: "observed"; source: N64RuntimeSourceEvidence }
  | { state: "unsupported-gitlink" }
  | { state: "unavailable" };

export function inspectN64RuntimeSource(
  revision: string,
  blob: { text: string; source_blob_sha1: string; source_sha256: string },
): N64RuntimeSourceEvidence {
  const fingerprint = n64RuntimeInputFingerprint(blob.text);
  return {
    repository: n64RuntimeRepository,
    repository_id: n64RuntimeRepositoryId,
    source_path: n64RuntimeInputPath,
    revision,
    blob_sha1: blob.source_blob_sha1,
    source_sha256: blob.source_sha256,
    input_blocks_sha256: fingerprint,
    matched_input_blocks: matchInputBlocks(fingerprint),
  };
}

export function readN64RuntimeSourceObservation(
  value: unknown,
): N64RuntimeSourceObservation | undefined {
  if (!isRecord(value)) return;
  if (value.state === "unavailable" || value.state === "unsupported-gitlink")
    return { state: value.state };
  const source = value.source;
  if (
    value.state !== "observed" ||
    !isRecord(source) ||
    source.repository !== n64RuntimeRepository ||
    source.repository_id !== n64RuntimeRepositoryId ||
    source.source_path !== n64RuntimeInputPath ||
    typeof source.revision !== "string" ||
    !gitSha.test(source.revision) ||
    typeof source.blob_sha1 !== "string" ||
    !gitSha.test(source.blob_sha1) ||
    typeof source.source_sha256 !== "string" ||
    !sha256.test(source.source_sha256) ||
    !(
      source.input_blocks_sha256 === null ||
      (typeof source.input_blocks_sha256 === "string" && sha256.test(source.input_blocks_sha256))
    ) ||
    source.matched_input_blocks !== matchInputBlocks(source.input_blocks_sha256)
  )
    return;
  return {
    state: "observed",
    source: {
      repository: n64RuntimeRepository,
      repository_id: n64RuntimeRepositoryId,
      source_path: n64RuntimeInputPath,
      revision: source.revision,
      blob_sha1: source.blob_sha1,
      source_sha256: source.source_sha256,
      input_blocks_sha256: source.input_blocks_sha256,
      matched_input_blocks: matchInputBlocks(source.input_blocks_sha256),
    },
  };
}
