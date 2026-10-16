import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export function checkDocumentLinks(root: string, files: readonly string[]) {
  for (const file of files.filter((name: string) => name.endsWith(".md"))) {
    const source = path.resolve(root, file);
    if (!existsSync(source)) continue;
    if (lstatSync(source).isSymbolicLink())
      throw new Error(`Linked source is not regular: ${file}`);
    const text = readFileSync(source, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = (match[1] ?? "").replace(/^<|>$/gu, "").split(/\s+"/u)[0] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      const [relative, anchor] = target.split("#", 2);
      const resolved = path.resolve(
        path.dirname(source),
        decodeURIComponent(relative || path.basename(source)),
      );
      const within = path.relative(root, resolved);
      if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
        throw new Error(`Documentation link escapes repository: ${file} -> ${target}`);
      if (!existsSync(resolved)) throw new Error(`Broken local link: ${file} -> ${target}`);
      if (anchor && resolved.endsWith(".md")) {
        const headings = [...readFileSync(resolved, "utf8").matchAll(/^#{1,6}\s+(.+)$/gmu)].map(
          (m) =>
            (m[1] ?? "")
              .trim()
              .toLowerCase()
              .replace(/[`*_~]/gu, "")
              .replace(/[^\p{L}\p{N}\s-]/gu, "")
              .replace(/\s+/gu, "-"),
        );
        // Duplicate headings use GitHub's numeric suffix; explicit HTML anchors are valid too.
        const content = readFileSync(resolved, "utf8");
        if (
          !headings.includes(decodeURIComponent(anchor)) &&
          !content.includes(`id="${anchor}"`) &&
          !content.includes(`name="${anchor}"`) &&
          !headings.some((h: string) =>
            new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-\\d+$`, "u").test(anchor),
          )
        )
          throw new Error(`Broken local anchor: ${file} -> ${target}`);
      }
    }
  }
}
