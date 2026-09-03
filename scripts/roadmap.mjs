import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const configPath = path.join(projectRoot, ".github", "roadmap.json");
const catalogPath = path.join(projectRoot, "crates", "portcove-core", "catalog", "catalog.json");

const layouts = new Set(["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"]);
const volatileKeys = new Set([
  "items", "item", "issues", "drafts", "status_value", "priority_value",
  "horizon_value", "target_release_value", "position", "positions",
]);
const setFlags = new Map([
  ["--status", "Status"],
  ["--priority", "Priority"],
  ["--horizon", "Horizon"],
  ["--release", "Target release"],
  ["--type", "Work type"],
  ["--workstream", "Workstream"],
  ["--platform", "Platform"],
  ["--port-stage", "Port stage"],
  ["--effort", "Effort"],
]);

function normalizedKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function ensureString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function findVolatileKey(value, prefix = "config") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const location = `${prefix}.${key}`;
    if (volatileKeys.has(key)) return location;
    const nested = findVolatileKey(child, location);
    if (nested) return nested;
  }
  return null;
}

export function validateConfig(config, { requireProjectNumber = false } = {}) {
  if (config?.schema_version !== 1) throw new Error("roadmap schema_version must be 1");
  ensureString(config.owner, "roadmap owner");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) {
    throw new Error("roadmap repository must be owner/name");
  }
  ensureString(config.project?.title, "project title");
  ensureString(config.project?.description, "project description");
  ensureString(config.project?.readme, "project readme");
  if (config.project?.visibility !== "PUBLIC") throw new Error("roadmap project must be PUBLIC");
  if (!Number.isInteger(config.project?.number) || config.project.number < 0) {
    throw new Error("project number must be a non-negative integer");
  }
  if (requireProjectNumber && config.project.number < 1) {
    throw new Error("project number is not recorded; run bootstrap and update .github/roadmap.json");
  }
  const fieldNames = new Set();
  for (const field of config.fields ?? []) {
    ensureString(field.name, "field name");
    if (fieldNames.has(field.name)) throw new Error(`duplicate field: ${field.name}`);
    fieldNames.add(field.name);
    if (!Array.isArray(field.options) || field.options.length === 0) {
      throw new Error(`field ${field.name} must define options`);
    }
    const options = new Set();
    for (const option of field.options) {
      ensureString(option, `${field.name} option`);
      if (options.has(option)) throw new Error(`duplicate ${field.name} option: ${option}`);
      options.add(option);
    }
  }
  for (const required of ["Status", "Priority", "Horizon", "Target release", "Work type", "Workstream", "Platform", "Port stage", "Effort"]) {
    if (!fieldNames.has(required)) throw new Error(`missing required roadmap field: ${required}`);
  }
  const viewNames = new Set();
  for (const view of config.views ?? []) {
    ensureString(view.name, "view name");
    if (viewNames.has(view.name)) throw new Error(`duplicate view: ${view.name}`);
    viewNames.add(view.name);
    if (!layouts.has(view.layout)) throw new Error(`view ${view.name} has invalid layout`);
    if (typeof view.filter !== "string" || !Array.isArray(view.fields) || view.fields.length === 0) {
      throw new Error(`view ${view.name} must define a filter and visible fields`);
    }
  }
  const volatile = findVolatileKey(config);
  if (volatile) throw new Error(`roadmap configuration contains volatile planning data at ${volatile}`);
  return config;
}

export function parseArguments(argv) {
  const command = argv[0];
  if (!command) throw new Error("missing command; use doctor, bootstrap, capture-port, capture-feature, promote, set, move, next, snapshot, or check");
  const options = {};
  const positionals = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.split("=", 2);
    const value = inline ?? argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[name] = value;
    if (inline === undefined) index += 1;
  }
  return { command, options, positionals };
}

export function fieldValue(item, fieldName) {
  const wanted = normalizedKey(fieldName);
  for (const [key, value] of Object.entries(item ?? {})) {
    if (normalizedKey(key) === wanted) return value;
  }
  for (const value of item?.fieldValues ?? []) {
    if (normalizedKey(value?.field?.name ?? value?.name) === wanted) {
      return value?.name ?? value?.value ?? value?.option?.name;
    }
  }
  return undefined;
}

function itemTitle(item) {
  return item?.title ?? item?.content?.title ?? "Untitled";
}

function itemUrl(item) {
  return item?.content?.url ?? item?.url;
}

function itemBody(item) {
  return item?.content?.body ?? item?.body ?? "";
}

function itemClosed(item) {
  const status = String(fieldValue(item, "Status") ?? "").toLowerCase();
  const state = String(item?.content?.state ?? item?.state ?? "").toLowerCase();
  return status === "done" || state === "closed" || state === "merged";
}

export function selectNextItems(items) {
  const priority = new Map([["Urgent", 0], ["High", 1], ["Medium", 2], ["Low", 3], ["None", 4]]);
  const horizon = new Map([["Now", 0], ["Next", 1]]);
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !itemClosed(item)
      && horizon.has(fieldValue(item, "Horizon"))
      && fieldValue(item, "Work type") !== "Workstream")
    .sort((left, right) => {
      const horizonOrder = horizon.get(fieldValue(left.item, "Horizon")) - horizon.get(fieldValue(right.item, "Horizon"));
      if (horizonOrder) return horizonOrder;
      const priorityOrder = (priority.get(fieldValue(left.item, "Priority")) ?? 5)
        - (priority.get(fieldValue(right.item, "Priority")) ?? 5);
      return priorityOrder || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function catalogQualificationSummary(catalog) {
  const ports = Array.isArray(catalog?.ports) ? catalog.ports : [];
  const byTier = {};
  const declared = new Set();
  const automated = new Set();
  const manual = new Set();
  for (const port of ports) {
    byTier[port.support_tier ?? "unspecified"] = (byTier[port.support_tier ?? "unspecified"] ?? 0) + 1;
    for (const platform of port.platforms ?? []) declared.add(`${port.id}:${platform}`);
    for (const platform of port.automated_tested_platforms ?? []) automated.add(`${port.id}:${platform}`);
    for (const platform of port.manually_validated_platforms ?? []) manual.add(`${port.id}:${platform}`);
  }
  return {
    ports: ports.length,
    byTier,
    declaredPlatformPairs: declared.size,
    automatedPlatformPairs: automated.size,
    manuallyValidatedPlatformPairs: manual.size,
  };
}

function markdownLink(item) {
  const url = itemUrl(item);
  const title = itemTitle(item).replaceAll("[", "\\[").replaceAll("]", "\\]");
  return url ? `[${title}](${url})` : title;
}

function itemLine(item) {
  const details = ["Status", "Priority", "Horizon", "Work type", "Workstream", "Platform"]
    .map(name => fieldValue(item, name) ? `${name}: ${fieldValue(item, name)}` : null)
    .filter(Boolean)
    .join("; ");
  return `- ${markdownLink(item)}${details ? ` — ${details}` : ""}`;
}

function evidenceLinks(items) {
  const urls = new Set();
  for (const item of items) {
    const contentUrl = itemUrl(item);
    if (contentUrl) urls.add(contentUrl);
    for (const match of itemBody(item).matchAll(/https:\/\/[^\s)>]+/g)) urls.add(match[0]);
  }
  return [...urls].sort();
}

export function renderSnapshot({ release, generatedAt, commit, projectUrl, items, catalog }) {
  const matching = items.filter(item => fieldValue(item, "Target release") === release);
  const complete = matching.filter(itemClosed);
  const unfinished = matching.filter(item => !itemClosed(item));
  const blockers = unfinished.filter(item => fieldValue(item, "Status") === "Blocked");
  const deferred = items.filter(item => ["Deferred", "Post-V1"].includes(fieldValue(item, "Status"))
    || fieldValue(item, "Target release") === "Post-V1");
  const summary = catalogQualificationSummary(catalog);
  const tiers = Object.entries(summary.byTier).sort().map(([name, count]) => `  - ${name}: ${count}`).join("\n") || "  - none";
  const section = values => values.length ? values.map(itemLine).join("\n") : "- None recorded.";
  const links = evidenceLinks(matching);
  return `# ${release} release readiness\n\n> Immutable snapshot generated from the live Portcove Roadmap and catalog. The Project remains authoritative after ${generatedAt}.\n\n- Generated: ${generatedAt}\n- Commit: \`${commit}\`\n- Project: ${projectUrl}\n- Target release: ${release}\n\n## Open blockers\n\n${section(blockers)}\n\n## Completed required items\n\n${section(complete)}\n\n## Unfinished required items\n\n${section(unfinished)}\n\n## Consciously deferred or postponed\n\n${section(deferred)}\n\n## Catalog qualification summary\n\n- Catalog entries: ${summary.ports}\n- Declared port/platform pairs: ${summary.declaredPlatformPairs}\n- Automated port/platform pairs: ${summary.automatedPlatformPairs}\n- Manually validated port/platform pairs: ${summary.manuallyValidatedPlatformPairs}\n- Support tiers:\n${tiers}\n\n## Evidence links\n\n${links.length ? links.map(url => `- ${url}`).join("\n") : "- No evidence links were recorded on matching Project items."}\n\n## Test, CI, rehearsal, signing, and human validation\n\n- Record reviewed test commands and results here.\n- Record required CI runs here.\n- Record release rehearsal evidence here.\n- Record signing/notarization evidence or the explicit unsigned limitation here.\n- Record required human and physical-platform evidence here.\n\n## Explicit limitations\n\n- Review every unfinished and deferred item above before publication.\n- This snapshot does not grant qualification or replace catalog evidence.\n- Project fields may change after generation; regenerate rather than editing this snapshot in place.\n`;
}

function unwrapCollection(value, key) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  if (Array.isArray(value?.nodes)) return value.nodes;
  return [];
}

export function planFieldReconciliation(desiredFields, actualResult, { freshProject = false } = {}) {
  const actualFields = unwrapCollection(actualResult, "fields");
  return desiredFields.map(desired => {
    const actual = actualFields.find(field => field.name === desired.name);
    if (!actual) return { action: "create", desired };
    const type = String(actual.dataType ?? actual.type ?? actual.__typename ?? "").toUpperCase();
    if (!type.includes("SINGLE") && !type.includes("SELECT")) {
      return { action: "error", desired, actual, reason: `${desired.name} is not a single-select field` };
    }
    const actualOptions = actual.options ?? [];
    const byName = new Map(actualOptions.map(option => [option.name, option]));
    const missing = desired.options.filter(option => !byName.has(option));
    const extra = actualOptions.filter(option => !desired.options.includes(option.name));
    if (!missing.length && (!freshProject || !extra.length)) return { action: "keep", desired, actual };
    const ordered = freshProject
      ? desired.options.map(name => byName.get(name) ?? { name, color: "GRAY", description: "" })
      : [
          ...actualOptions,
          ...missing.map(name => ({ name, color: "GRAY", description: "" })),
        ];
    return { action: "update", desired, actual, options: ordered };
  });
}

export function planViewReconciliation(desiredViews, actualViews) {
  const byName = new Map(actualViews.map(view => [view.name, view]));
  return desiredViews.map(view => ({
    action: byName.has(view.name) ? "update" : "create",
    desired: view,
    actual: byName.get(view.name),
  }));
}

function defaultRunner(args, input) {
  const command = process.env.PORTCOVE_ROADMAP_GH || "gh";
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    input,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} failed with exit ${result.status}`);
  return result.stdout.trim();
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git rev-parse HEAD failed");
  return result.stdout.trim();
}

export class RoadmapClient {
  constructor(config, run = defaultRunner) {
    this.config = config;
    this.run = run;
  }

  gh(args, input) {
    return this.run(args, input);
  }

  json(args, input) {
    const output = this.gh(args, input);
    return output ? JSON.parse(output) : null;
  }

  graphql(query, variables = {}) {
    const result = this.json(["api", "graphql", "--input", "-"], `${JSON.stringify({ query, variables })}\n`);
    if (result?.errors?.length) throw new Error(result.errors.map(error => error.message).join("; "));
    return result?.data;
  }

  listProjects() {
    return unwrapCollection(this.json(["project", "list", "--owner", this.config.owner, "--format", "json", "--limit", "100"]), "projects");
  }

  resolveProject({ create = false } = {}) {
    const matches = this.listProjects().filter(project => project.title === this.config.project.title && project.closed !== true);
    if (matches.length > 1) throw new Error(`multiple open projects named ${this.config.project.title}`);
    if (matches.length === 1) return { project: matches[0], created: false };
    if (!create) throw new Error(`${this.config.project.title} does not exist; run bootstrap`);
    const project = this.json(["project", "create", "--owner", this.config.owner, "--title", this.config.project.title, "--format", "json"]);
    return { project, created: true };
  }

  projectNumber(project) {
    const number = Number(project?.number ?? this.config.project.number);
    if (!Number.isInteger(number) || number < 1) throw new Error("could not determine Project number");
    return number;
  }

  projectDetails(number) {
    return this.json(["project", "view", String(number), "--owner", this.config.owner, "--format", "json"]);
  }

  fieldList(number) {
    return this.json(["project", "field-list", String(number), "--owner", this.config.owner, "--format", "json", "--limit", "100"]);
  }

  itemList(number) {
    return unwrapCollection(this.json(["project", "item-list", String(number), "--owner", this.config.owner, "--format", "json", "--limit", "1000"]), "items");
  }

  projectContext(number = this.config.project.number) {
    if (this._projectContext?.number === number) return this._projectContext;
    const details = this.projectDetails(number);
    const fields = unwrapCollection(this.fieldList(number), "fields");
    this._projectContext = { number, details, fields };
    return this._projectContext;
  }

  ensureIssueItem(contentId) {
    const { details } = this.projectContext();
    const find = () => {
      const query = `query($id: ID!) { node(id: $id) { ... on Issue { projectItems(first: 100) { nodes { id project { id } } } } } }`;
      return this.graphql(query, { id: contentId })?.node?.projectItems?.nodes
        ?.find(item => item.project?.id === details.id);
    };
    const existing = find();
    if (existing) return existing;
    const mutation = `mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }`;
    try {
      return this.graphql(mutation, { input: { projectId: details.id, contentId } })?.addProjectV2ItemById?.item;
    } catch (error) {
      if (!/already|exists/i.test(error.message)) throw error;
      const raced = find();
      if (raced) return raced;
      throw error;
    }
  }

  viewList(projectId) {
    const query = `query($id: ID!) { node(id: $id) { ... on ProjectV2 { views(first: 100) { nodes { id name number layout filter fields(first: 50) { nodes { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } ... on ProjectV2MultiSelectField { id name } } } groupByFields(first: 10) { nodes { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } ... on ProjectV2MultiSelectField { id name } } } sortByFields(first: 10) { nodes { direction field { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } ... on ProjectV2MultiSelectField { id name } } } } } } } } }`;
    return this.graphql(query, { id: projectId })?.node?.views?.nodes ?? [];
  }

  editProject(number) {
    this.gh([
      "project", "edit", String(number), "--owner", this.config.owner,
      "--title", this.config.project.title,
      "--description", this.config.project.description,
      "--readme", this.config.project.readme,
      "--visibility", this.config.project.visibility,
    ]);
  }

  updateField(fieldId, options) {
    const query = `mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } } } }`;
    const singleSelectOptions = options.map(option => ({
      ...(option.id ? { id: option.id } : {}),
      name: option.name,
      color: option.color ?? "GRAY",
      description: option.description ?? "",
    }));
    this.graphql(query, { input: { fieldId, singleSelectOptions } });
  }

  reconcileFields(number, { freshProject = false } = {}) {
    const plan = planFieldReconciliation(this.config.fields, this.fieldList(number), { freshProject });
    for (const step of plan) {
      if (step.action === "error") throw new Error(step.reason);
      if (step.action === "create") {
        this.gh([
          "project", "field-create", String(number), "--owner", this.config.owner,
          "--name", step.desired.name, "--data-type", "SINGLE_SELECT",
          "--single-select-options", step.desired.options.join(","),
        ]);
      } else if (step.action === "update") {
        this.updateField(step.actual.id, step.options);
      }
    }
    return plan;
  }

  reconcileViews(projectId, fieldResult) {
    const fields = unwrapCollection(fieldResult, "fields");
    const fieldIds = new Map(fields.map(field => [field.name, field.id]));
    const plan = planViewReconciliation(this.config.views, this.viewList(projectId));
    for (const step of plan) {
      const visibleFieldIds = step.desired.fields.map(name => {
        const id = fieldIds.get(name);
        if (!id) throw new Error(`view ${step.desired.name} references missing field ${name}`);
        return id;
      });
      if (step.action === "create") {
        const query = `mutation($input: CreateProjectV2ViewInput!) { createProjectV2View(input: $input) { projectV2View { id name } } }`;
        this.graphql(query, { input: {
          projectId,
          name: step.desired.name,
          layout: step.desired.layout,
          configuration: { visibleFieldIds },
        }});
        const created = this.viewList(projectId).find(view => view.name === step.desired.name);
        if (!created) throw new Error(`view ${step.desired.name} was not created`);
        const update = `mutation($input: UpdateProjectV2ViewInput!) { updateProjectV2View(input: $input) { projectV2View { id name filter } } }`;
        this.graphql(update, { input: { viewId: created.id, filter: step.desired.filter } });
      } else {
        const query = `mutation($input: UpdateProjectV2ViewInput!) { updateProjectV2View(input: $input) { projectV2View { id name filter } } }`;
        this.graphql(query, { input: {
          viewId: step.actual.id,
          name: step.desired.name,
          layout: step.desired.layout,
          filter: step.desired.filter,
          configuration: { visibleFieldIds },
        }});
      }
    }
    return plan;
  }

  removeFreshDefaultView(projectId, created) {
    if (!created) return false;
    const desiredNames = new Set(this.config.views.map(view => view.name));
    const defaultView = this.viewList(projectId).find(view =>
      view.number === 1 && view.name === "View 1" && !view.filter && !desiredNames.has(view.name));
    if (!defaultView) return false;
    const query = `mutation($input: DeleteProjectV2ViewInput!) { deleteProjectV2View(input: $input) { projectV2View { id } } }`;
    this.graphql(query, { input: { viewId: defaultView.id } });
    return true;
  }

  bootstrap() {
    const { project, created } = this.resolveProject({ create: true });
    const number = this.projectNumber(project);
    this.editProject(number);
    try {
      this.gh(["project", "link", String(number), "--owner", this.config.owner, "--repo", this.config.repository]);
    } catch (error) {
      if (!/already|exists|linked/i.test(error.message)) throw error;
    }
    const fieldPlan = this.reconcileFields(number, { freshProject: created });
    const details = this.projectDetails(number);
    const fields = this.fieldList(number);
    const viewPlan = this.reconcileViews(details.id ?? project.id, fields);
    const removedDefaultView = this.removeFreshDefaultView(details.id ?? project.id, created);
    return {
      number,
      url: details.url ?? project.url ?? `https://github.com/users/${this.config.owner}/projects/${number}`,
      created,
      fieldPlan,
      viewPlan,
      removedDefaultView,
    };
  }

  setFields(reference, values) {
    const number = this.config.project.number;
    if (number < 1) throw new Error("project number is not recorded in .github/roadmap.json");
    const url = reference.startsWith("http")
      ? reference
      : /^#?\d+$/.test(reference)
        ? `https://github.com/${this.config.repository}/issues/${reference.replace(/^#/, "")}`
        : null;
    if (url) {
      for (const [field, value] of Object.entries(values)) {
        this.gh(["project", "item-edit", String(number), "--owner", this.config.owner, "--url", url, "--field", field, "--value", value]);
      }
      return;
    }

    this.setItemFields(reference, values);
  }

  setItemFields(itemId, values) {
    const { details, fields } = this.projectContext();
    for (const [fieldName, value] of Object.entries(values)) {
      const field = fields.find(candidate => candidate.name === fieldName);
      if (!field) throw new Error(`Project field not found: ${fieldName}`);
      const option = field.options?.find(candidate => candidate.name === value);
      if (!option) throw new Error(`Project option not found: ${fieldName}=${value}`);
      this.gh([
        "project", "item-edit", "--id", itemId, "--project-id", details.id,
        "--field-id", field.id, "--single-select-option-id", option.id,
      ]);
    }
  }

  capture({ title, body, fields }) {
    const number = this.config.project.number;
    const item = this.json(["project", "item-create", String(number), "--owner", this.config.owner, "--title", title, "--body", body, "--format", "json"]);
    this.setFields(item.id, fields);
    return item;
  }

  promote(itemId) {
    const repository = this.graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`, {
      owner: this.config.repository.split("/")[0],
      name: this.config.repository.split("/")[1],
    })?.repository;
    if (!repository?.id) throw new Error("repository was not found");
    const query = `mutation($input: ConvertProjectV2DraftIssueItemToIssueInput!) { convertProjectV2DraftIssueItemToIssue(input: $input) { item { id content { ... on Issue { number title url } } } } }`;
    return this.graphql(query, { input: { itemId, repositoryId: repository.id } })
      ?.convertProjectV2DraftIssueItemToIssue?.item;
  }

  moveBefore(itemReference, beforeReference) {
    const details = this.projectDetails(this.config.project.number);
    const items = this.itemList(this.config.project.number);
    const matches = (item, reference) => item.id === reference || itemUrl(item) === reference
      || itemTitle(item) === reference || String(item?.content?.number ?? "") === reference.replace(/^#/, "");
    const moving = items.find(item => matches(item, itemReference));
    const before = items.find(item => matches(item, beforeReference));
    if (!moving || !before) throw new Error("move could not resolve both items");
    const remaining = items.filter(item => item.id !== moving.id);
    const beforeIndex = remaining.findIndex(item => item.id === before.id);
    const afterId = beforeIndex <= 0 ? null : remaining[beforeIndex - 1].id;
    const query = `mutation($input: UpdateProjectV2ItemPositionInput!) { updateProjectV2ItemPosition(input: $input) { items(first: 1) { totalCount } } }`;
    this.graphql(query, { input: { projectId: details.id, itemId: moving.id, afterId } });
  }
}

async function loadConfig({ requireProjectNumber = false } = {}) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  return validateConfig(config, { requireProjectNumber });
}

async function offlineCheck() {
  const config = await loadConfig({ requireProjectNumber: true });
  const forbiddenLedger = path.join(projectRoot, "docs", "project", "ledger.json");
  try {
    await access(forbiddenLedger);
    throw new Error("docs/project/ledger.json must not exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const currentDocs = await Promise.all([
    "README.md", "AGENTS.md", "CONTRIBUTING.md", "docs/CATALOG.md", "docs/ROADMAP.md",
    "docs/PROJECT-GOVERNANCE.md", "docs/RELEASING.md",
  ].map(async relative => [relative, await readFile(path.join(projectRoot, relative), "utf8")]));
  for (const [relative, text] of currentDocs) {
    if (/\b(?:current|all)\s+\d+-port\b/i.test(text) || /\bcurrent\s+\d+\s+ports\b/i.test(text)) {
      throw new Error(`${relative} hardcodes a live catalog count`);
    }
  }
  console.log(`Roadmap configuration is valid for ${config.owner}/${config.project.number}; no volatile item data is stored.`);
}

function requiredOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed.command === "check") {
    await offlineCheck();
    return;
  }
  const config = await loadConfig({ requireProjectNumber: !["doctor", "bootstrap"].includes(parsed.command) });
  const client = new RoadmapClient(config);
  if (parsed.command === "doctor") {
    client.gh(["auth", "status"]);
    const { project } = client.resolveProject();
    const number = client.projectNumber(project);
    const details = client.projectDetails(number);
    const fields = unwrapCollection(client.fieldList(number), "fields");
    const views = client.viewList(details.id ?? project.id);
    const missingFields = planFieldReconciliation(config.fields, { fields }).filter(step => step.action !== "keep");
    const missingViews = config.views.filter(view => !views.some(actual => actual.name === view.name));
    if (missingFields.length || missingViews.length) {
      throw new Error(`Project drift: ${missingFields.length} field definitions and ${missingViews.length} views require bootstrap`);
    }
    console.log(`Portcove Roadmap #${number} is reachable at ${details.url ?? project.url}; ${fields.length} fields and ${views.length} views found.`);
    return;
  }
  if (parsed.command === "bootstrap") {
    const result = client.bootstrap();
    console.log(`${result.created ? "Created" : "Reconciled"} Portcove Roadmap #${result.number}: ${result.url}`);
    if (config.project.number !== result.number) {
      console.log(`Record project.number=${result.number} in .github/roadmap.json before using item commands.`);
    }
    console.log("View filters and visible columns are reconciled. Confirm grouping, sorting, and built-in workflows in the GitHub UI.");
    return;
  }
  if (parsed.command === "capture-port") {
    const title = requiredOption(parsed.options, "--title");
    const url = requiredOption(parsed.options, "--url");
    if (!/^https:\/\//.test(url)) throw new Error("--url must be an https URL");
    const item = client.capture({
      title,
      body: `Upstream: ${url}\n\nWhy it may matter:\n- Pending initial triage.\n\nTriage observations:\n- Platforms: pending\n- Source contract: pending\n- Artifact integrity: pending\n- Persistence: pending\n- Adapter fit: pending`,
      fields: { Status: "Inbox", Priority: "None", Horizon: "Someday", "Target release": "Unscheduled", "Work type": "Port", Workstream: "Port catalog", Platform: "Multi-platform", "Port stage": "Watchlist", Effort: "Unknown" },
    });
    console.log(`Captured draft port ${itemTitle(item)} (${item.id}).`);
    return;
  }
  if (parsed.command === "capture-feature") {
    const title = requiredOption(parsed.options, "--title");
    const item = client.capture({
      title,
      body: "User outcome:\n- Pending triage.\n\nCurrent behavior/evidence:\n- Pending.\n\nScope:\n- Pending.\n\nNon-goals:\n- Pending.",
      fields: { Status: "Inbox", Priority: "None", Horizon: "Someday", "Target release": "Unscheduled", "Work type": "Product feature", Workstream: "Documentation and governance", Platform: "All", Effort: "Unknown" },
    });
    console.log(`Captured draft feature ${itemTitle(item)} (${item.id}).`);
    return;
  }
  if (parsed.command === "promote") {
    if (parsed.positionals.length !== 1) throw new Error("usage: roadmap.mjs promote <draft-item-id>");
    const item = client.promote(parsed.positionals[0]);
    console.log(`Promoted draft to ${item?.content?.url ?? item?.id}.`);
    return;
  }
  if (parsed.command === "set") {
    if (parsed.positionals.length !== 1) throw new Error("usage: roadmap.mjs set <item-or-issue> [field options]");
    const values = {};
    for (const [flag, value] of Object.entries(parsed.options)) {
      const field = setFlags.get(flag);
      if (!field) throw new Error(`unsupported set option: ${flag}`);
      const definition = config.fields.find(candidate => candidate.name === field);
      if (!definition.options.includes(value)) throw new Error(`${value} is not a valid ${field} option`);
      values[field] = value;
    }
    if (!Object.keys(values).length) throw new Error("set requires at least one field option");
    client.setFields(parsed.positionals[0], values);
    console.log(`Updated ${parsed.positionals[0]}: ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(", ")}.`);
    return;
  }
  if (parsed.command === "move") {
    if (parsed.positionals.length !== 1) throw new Error("usage: roadmap.mjs move <item> --before <item>");
    client.moveBefore(parsed.positionals[0], requiredOption(parsed.options, "--before"));
    console.log(`Moved ${parsed.positionals[0]} before ${parsed.options["--before"]}.`);
    return;
  }
  if (parsed.command === "next") {
    const items = selectNextItems(client.itemList(config.project.number));
    if (!items.length) {
      console.log("No unfinished non-workstream items are in Now or Next.");
      return;
    }
    console.log(items.map((item, index) => `${index + 1}. ${itemTitle(item)} | ${fieldValue(item, "Priority") ?? "None"} | ${fieldValue(item, "Horizon")} | ${fieldValue(item, "Status") ?? "Unassigned"}${itemUrl(item) ? ` | ${itemUrl(item)}` : ""}`).join("\n"));
    return;
  }
  if (parsed.command === "snapshot") {
    const release = requiredOption(parsed.options, "--release");
    const output = requiredOption(parsed.options, "--output");
    if (!config.fields.find(field => field.name === "Target release").options.includes(release)) throw new Error(`unknown target release: ${release}`);
    const outputPath = path.resolve(projectRoot, output);
    const releasesRoot = path.join(projectRoot, "docs", "releases");
    if (outputPath !== releasesRoot && !outputPath.startsWith(`${releasesRoot}${path.sep}`)) {
      throw new Error("snapshot output must be under docs/releases");
    }
    const { writeFile } = await import("node:fs/promises");
    try {
      await access(outputPath);
      throw new Error(`snapshot output already exists: ${output}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const [catalog, commit] = await Promise.all([
      readFile(catalogPath, "utf8").then(JSON.parse),
      Promise.resolve(gitHead()),
    ]);
    const document = renderSnapshot({
      release,
      generatedAt: new Date().toISOString(),
      commit,
      projectUrl: `https://github.com/users/${config.owner}/projects/${config.project.number}`,
      items: client.itemList(config.project.number),
      catalog,
    });
    await writeFile(outputPath, document, { encoding: "utf8", flag: "wx" });
    console.log(`Wrote immutable readiness snapshot ${path.relative(projectRoot, outputPath)}.`);
    return;
  }
  throw new Error(`unknown command: ${parsed.command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`roadmap: ${error.message}`);
    process.exitCode = 1;
  }
}
