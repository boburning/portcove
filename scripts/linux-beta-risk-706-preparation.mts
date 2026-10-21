/** Exact version-only projection, never a security reassessment or approval. */

export async function inspectRiskVersionPreparation706(
  head: string,
  read: (args: readonly string[]) => string,
) {
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("#706 exact prepared commit required");
  const raw = read(["cat-file", "commit", head]);
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("#706 commit metadata exceeds bound");
  // Ordinary source commits retain their original full native-diff check. A
  // preparation claim must pass the complete existing transform verifier.
  if (!raw.includes("\nPortcove-Preparation-SHA256:")) return null;
  const match =
    /^tree ([a-f0-9]{40})\nparent ([a-f0-9]{40})\n[\s\S]*?\n\nPrepare application ([^\n]+)\n\nPortcove-Preparation-SHA256: ([a-f0-9]{64})\n/u.exec(
      raw,
    );
  if (!match) throw new Error("#706 malformed version preparation claim");
  const source = match[2]!;
  const candidate = {
    source_commit: source,
    source_tree: read(["rev-parse", `${source}^{tree}`]).trim(),
    prepared_commit: head,
    prepared_tree: match[1]!,
    version: match[3]!,
    intent_sha256: match[4]!,
  };
  // Literal internal import is bundled by the fixed packer. Lightweight source
  // readers need no release-policy packages until a real preparation claim.
  const { inspectPreparedReleaseVersionObjects } =
    await import("../apps/desktop/scripts/prepare-release-version.mts");
  inspectPreparedReleaseVersionObjects((args) => read(args), candidate);
  return candidate;
}
