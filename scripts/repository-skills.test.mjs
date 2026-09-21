import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyChanges } from "./local-validation.mjs";

const skillsRoot = new URL("../.agents/skills/", import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
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

function documentedJustRecipes(source) {
  return [...source.matchAll(/`just\s+([a-z0-9][a-z0-9-]*)(?:\s+[^`\r\n]*)?`/giu)].map(
    (match) => match[1],
  );
}

function fencedShellCommands(source) {
  return [...source.matchAll(/```(?:powershell|pwsh|bash|sh)\r?\n([\s\S]*?)```/giu)]
    .flatMap((match) => match[1].split(/\r?\n/u))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function commandOptions(source) {
  return new Set([...source.matchAll(/--[a-z][a-z-]*/gu)].map((match) => match[0]));
}

function documentedPrCommands(source) {
  return [...source.matchAll(/`just\s+(pr-(?:watch|merge-rest))(?:\s+([^`\r\n]*))?`/gu)].map(
    (match) => ({ recipe: match[1], options: commandOptions(match[2] ?? "") }),
  );
}

function deliveryUsage(source) {
  return new Map(
    [...source.matchAll(/node scripts\/pr-delivery\.mjs (watch|merge) ([^"\r\n]+)/gu)].map(
      (match) => [
        match[1],
        {
          allowed: commandOptions(match[2]),
          required: commandOptions(match[2].split("[", 1)[0]),
        },
      ],
    ),
  );
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

function repositoryPath(file) {
  const relative = path.relative(projectRoot, fileURLToPath(file)).replaceAll(path.sep, "/");
  assert.ok(relative && !relative.startsWith("../"), `${file.href} must stay in the repository`);
  return relative;
}

async function assertLocalLinksResolve(file) {
  const source = await readFile(file, "utf8");
  for (const target of localMarkdownLinks(source)) await assertLocalLinkResolves(file, target);
}

async function assertLocalLinkResolves(file, target) {
  const [targetPath, anchor] = target.split("#", 2);
  const destination = new URL(targetPath, file);
  const relative = repositoryPath(destination);
  let current = projectRoot;
  for (const segment of relative.split("/")) {
    const entries = await readdir(current);
    assert.ok(
      entries.includes(segment),
      `${file.pathname} link must use exact path spelling: ${target}`,
    );
    current = path.join(current, segment);
  }
  await assert.doesNotReject(access(destination), `${file.pathname} link must resolve: ${target}`);
  if (anchor) {
    const destinationSource = await readFile(destination, "utf8");
    assert.ok(
      headingAnchors(destinationSource).has(anchor),
      `${file.pathname} anchor must resolve: ${target}`,
    );
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
    assert.ok(metadata.description.length > 0, `${directory.name} must have a description`);
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
  assert.ok(
    localMarkdownLinks(documentationIndex).some(
      (target) => target.split("#", 1)[0] === "DEVELOPMENT-TOOLS.md",
    ),
    "the documentation index must link to development tooling",
  );
});

test("active instruction entrypoints have valid local links and anchors", async () => {
  const files = [
    new URL("../AGENTS.md", import.meta.url),
    new URL("../CONTRIBUTING.md", import.meta.url),
    new URL("../docs/README.md", import.meta.url),
    new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
    new URL("../docs/DEVELOPMENT-TOOLS.md", import.meta.url),
    new URL("../docs/DEVELOPMENT-STORAGE.md", import.meta.url),
  ];
  const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  files.push(...skillDirectories.map((entry) => new URL(`${entry.name}/SKILL.md`, skillsRoot)));

  for (const file of files) await assertLocalLinksResolve(file);
});

test("local links require exact path spelling on case-insensitive hosts", async () => {
  await assert.rejects(
    assertLocalLinkResolves(
      new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
      "../Justfile",
    ),
    /link must use exact path spelling: \.\.\/Justfile/u,
  );
});

test("workflow guidance routes to owned contracts without unsafe runnable shortcuts", async () => {
  const storage = await readFile(
    new URL("../docs/DEVELOPMENT-STORAGE.md", import.meta.url),
    "utf8",
  );
  const storageLinks = localMarkdownLinks(storage);
  const toolLinks = localMarkdownLinks(developmentTools);
  assert.ok(
    storageLinks.some((target) => target.startsWith("DEVELOPMENT-TOOLS.md#")),
    "storage guidance must route warm work through development tooling",
  );
  assert.ok(
    toolLinks.some((target) => target.split("#", 1)[0] === "DEVELOPMENT-STORAGE.md"),
    "development tooling must route storage changes to their owner",
  );
  assert.ok(
    toolLinks.some((target) => target.split("#", 1)[0] === "CONTRIBUTION-CONVENTIONS.md"),
    "development tooling must route review and merge through contribution conventions",
  );

  const forbidden = [
    /^git\s+(?:reset|stash)\b/iu,
    /^cargo\s+clean\b/iu,
    /^just\s+(?:check|audit)\s*$/iu,
    /^(?:corepack\s+)?pnpm\s+install\b/iu,
  ];
  assert.deepEqual(fencedShellCommands("```pwsh\njust local-check --plan\n```"), [
    "just local-check --plan",
  ]);
  const commands = fencedShellCommands(`${storage}\n${developmentTools}`);
  assert.ok(commands.length > 0, "expected runnable workflow commands");
  for (const command of commands) {
    for (const pattern of forbidden)
      assert.doesNotMatch(command, pattern, `unsafe warm-workflow shortcut: ${command}`);
  }
  for (const unsafe of ["git reset --hard", "git stash", "cargo clean", "just audit"]) {
    assert.deepEqual(fencedShellCommands(`\`\`\`pwsh\n${unsafe}\n\`\`\``), [unsafe]);
    assert.ok(
      forbidden.some((pattern) => pattern.test(unsafe)),
      `must reject ${unsafe}`,
    );
  }
});

test("every instruction dependency selects this contract locally", async () => {
  const files = [
    new URL("../AGENTS.md", import.meta.url),
    new URL("../CONTRIBUTING.md", import.meta.url),
    new URL("../docs/README.md", import.meta.url),
    new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url),
    new URL("../docs/DEVELOPMENT-TOOLS.md", import.meta.url),
    new URL("../docs/DEVELOPMENT-STORAGE.md", import.meta.url),
  ];
  const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  files.push(...skillDirectories.map((entry) => new URL(`${entry.name}/SKILL.md`, skillsRoot)));

  const dependencies = new Set(["crates/portcove-core/src/catalog.rs", "scripts/pr-delivery.mjs"]);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    dependencies.add(repositoryPath(file));
    for (const target of localMarkdownLinks(source)) {
      const [targetPath] = target.split("#", 1);
      dependencies.add(repositoryPath(new URL(targetPath, file)));
    }
  }

  const missing = [];
  for (const dependency of dependencies) {
    const selection = classifyChanges([{ status: "M", path: dependency }], {
      fileExists: () => true,
    });
    if (!selection.nodeTests.has("scripts/repository-skills.test.mjs")) missing.push(dependency);
  }
  assert.deepEqual(missing, [], "every instruction dependency must select this contract locally");
});

test("documented repository-skill and PR-delivery commands exist", async () => {
  const portSkill = await readFile(
    new URL("../.agents/skills/portcove-port-qualification/SKILL.md", import.meta.url),
    "utf8",
  );
  const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  const justfile = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const recipes = new Set(
    [...justfile.matchAll(/^([a-z0-9][a-z0-9-]*)(?:\s+[^:]*)?:/gimu)].map((match) => match[1]),
  );
  const documentedRecipes = [];
  for (const directory of skillDirectories) {
    const source = await readFile(new URL(`${directory.name}/SKILL.md`, skillsRoot), "utf8");
    documentedRecipes.push(...documentedJustRecipes(source));
  }
  documentedRecipes.push(
    ...documentedJustRecipes(
      await readFile(new URL("../docs/CONTRIBUTION-CONVENTIONS.md", import.meta.url), "utf8"),
    ),
  );
  documentedRecipes.push(...documentedJustRecipes(developmentTools));
  assert.ok(documentedRecipes.length > 0, "expected documented just recipes");
  assert.deepEqual(
    [...new Set(documentedRecipes.filter((recipe) => !recipes.has(recipe)))],
    [],
    "documented just recipes must exist",
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

  const catalogTest = /`just test-rust -p portcove-core ([a-z0-9_]+)`/iu.exec(portSkill)?.[1];
  assert.ok(catalogTest, "port qualification must name its focused catalog test");
  assert.match(
    catalogSource,
    new RegExp(`fn ${catalogTest}\\(\\)`, "u"),
    "the documented catalog test must exist",
  );
  assert.ok(documentedJustRecipes(conventions).includes("pr-watch"));
  assert.ok(documentedJustRecipes(conventions).includes("pr-merge-rest"));
  const delegates = new Map(
    [
      ...justfile.matchAll(
        /^(pr-(?:watch|merge-rest))\s+\*args:\r?\n\s+.*pr-delivery\.mjs\s+(watch|merge)\s+/gmu,
      ),
    ].map((match) => [match[1], match[2]]),
  );
  const usage = deliveryUsage(deliveryScript);
  assert.deepEqual([...delegates.keys()].sort(), ["pr-merge-rest", "pr-watch"]);
  assert.deepEqual([...usage.keys()].sort(), ["merge", "watch"]);
  const documentedCommands = documentedPrCommands(conventions);
  assert.deepEqual(
    documentedCommands.map(({ recipe }) => recipe).sort(),
    ["pr-merge-rest", "pr-watch"],
    "both PR-delivery recipes must have one complete documented invocation",
  );
  for (const documented of documentedCommands) {
    const command = delegates.get(documented.recipe);
    const contract = usage.get(command);
    assert.ok(contract, `${documented.recipe} must delegate to a documented delivery command`);
    assert.deepEqual(
      [...documented.options].filter((option) => !contract.allowed.has(option)),
      [],
      `${documented.recipe} documents unsupported options`,
    );
    assert.deepEqual(
      [...contract.required].filter((option) => !documented.options.has(option)),
      [],
      `${documented.recipe} must document every required option`,
    );
  }
});
