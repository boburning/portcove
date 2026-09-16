import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const skillsRoot = new URL("../.agents/skills/", import.meta.url);
const documentationIndex = await readFile(new URL("../docs/README.md", import.meta.url), "utf8");
const developmentTools = await readFile(
  new URL("../docs/DEVELOPMENT-TOOLS.md", import.meta.url),
  "utf8",
);
const rootGuidance = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");

function frontmatter(source, label) {
  const match = /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n/u.exec(source);
  assert.ok(match, `${label} must start with exact name and description frontmatter`);
  return { name: match[1].trim(), description: match[2].trim() };
}

function localMarkdownLinks(source) {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1].trim())
    .filter((target) => target && !target.startsWith("#") && !/^https?:\/\//u.test(target));
}

function headingAnchors(source) {
  return new Set(
    [...source.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) =>
      match[1]
        .trim()
        .toLowerCase()
        .replace(/[`*_~]/gu, "")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/gu, "-"),
    ),
  );
}

async function assertLocalLinksResolve(file) {
  const source = await readFile(file, "utf8");
  for (const target of localMarkdownLinks(source)) {
    const [path, anchor] = target.split("#", 2);
    const destination = new URL(path, file);
    await assert.doesNotReject(
      access(destination),
      `${file.pathname} link must resolve: ${target}`,
    );
    if (anchor) {
      const destinationSource = await readFile(destination, "utf8");
      assert.ok(
        headingAnchors(destinationSource).has(anchor),
        `${file.pathname} anchor must resolve: ${target}`,
      );
    }
  }
}

test("repository skills have discoverable triggers, checkout anchoring, and valid links", async () => {
  const directories = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.ok(directories.length > 0, "expected at least one repository skill");

  for (const directory of directories) {
    const skillFile = new URL(`${directory.name}/SKILL.md`, skillsRoot);
    const source = await readFile(skillFile, "utf8");
    const metadata = frontmatter(source, directory.name);

    assert.equal(metadata.name, directory.name, `${directory.name} frontmatter name must match`);
    assert.match(metadata.description, /\bUse\b/u, `${directory.name} must state its trigger`);
    assert.match(
      source,
      /git rev-parse --show-toplevel/u,
      `${directory.name} must resolve the active checkout root`,
    );
    assert.ok(
      developmentTools.includes(`\`${directory.name}\``),
      `${directory.name} must be discoverable in development tooling`,
    );
    assert.ok(
      rootGuidance.includes(directory.name),
      `${directory.name} must be routed from root guidance`,
    );

    for (const target of localMarkdownLinks(source)) {
      const [path] = target.split("#", 1);
      await assert.doesNotReject(
        access(new URL(path, skillFile)),
        `${directory.name} link must resolve: ${target}`,
      );
    }
  }
});

test("the documentation index routes development tooling and repository skills", () => {
  assert.match(
    documentationIndex,
    /\[Development tooling and repository skills\]\(DEVELOPMENT-TOOLS\.md\)/u,
  );
});

test("active instruction entrypoints have valid local links and anchors", async () => {
  const files = [
    new URL("../CONTRIBUTING.md", import.meta.url),
    new URL("../docs/README.md", import.meta.url),
    new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
    new URL("../docs/DEVELOPMENT-TOOLS.md", import.meta.url),
  ];
  const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  files.push(...skillDirectories.map((entry) => new URL(`${entry.name}/SKILL.md`, skillsRoot)));

  for (const file of files) await assertLocalLinksResolve(file);
});

test("documented qualification and PR-delivery commands exist", async () => {
  const portSkill = await readFile(
    new URL("../.agents/skills/portcove-port-qualification/SKILL.md", import.meta.url),
    "utf8",
  );
  const catalogSource = await readFile(
    new URL("../crates/portcove-core/src/catalog.rs", import.meta.url),
    "utf8",
  );
  const conventions = await readFile(
    new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
    "utf8",
  );
  const deliveryScript = await readFile(new URL("./pr-delivery.mjs", import.meta.url), "utf8");

  assert.match(
    portSkill,
    /just test-rust -p portcove-core embedded_catalog_is_valid_and_contains_lighthouse/u,
  );
  assert.match(catalogSource, /fn embedded_catalog_is_valid_and_contains_lighthouse\(\)/u);
  assert.match(conventions, /--timeout-seconds <positive-integer>/u);
  assert.match(deliveryScript, /--timeout-seconds <seconds>/u);
});
