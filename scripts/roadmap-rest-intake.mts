import { RoadmapClient } from "./roadmap.mts";
import type { RoadmapIssueItem } from "./roadmap.mts";
import { RestInventoryTransport } from "./github-rest-inventory.mts";
import { collectRestRepositoryIssueInventory } from "./repository-issue-inventory.mts";
import { isRecord } from "./runtime-values.mts";

const object = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("Malformed REST Project object");
  return value;
};
const positive = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Missing numeric REST Project identity");
  return value;
};
interface RestField {
  id: number;
  node: string;
  name: string;
  options: Map<string, string>;
}

/** REST transport for freshly created canonical ports, not historical normalization
 * or global Project health. Those retain explicit archived-membership validation. */
export class RestPortIntakeClient extends RoadmapClient {
  readonly rest = new RestInventoryTransport(this.api);
  private created = new Map<string, number>();
  private items = new Map<string, { id: number; content: string }>();
  private projectNode: string | undefined;
  private root: string | undefined;
  private aliases: string[] = [];
  private fields: RestField[] | undefined;
  private fieldsRevision: string | undefined;

  override repositoryIssues(options: { projectMemberships?: boolean } = {}) {
    if (options.projectMemberships)
      throw new Error("REST intake does not claim archived Project coverage");
    return collectRestRepositoryIssueInventory(this, this.rest);
  }

  override createPortIssue(input: Parameters<RoadmapClient["createPortIssue"]>[0]) {
    return super.createPortIssue({
      ...input,
      onIssueCreated: (issue) => {
        this.created.set(issue.node_id, issue.number);
        input.onIssueCreated?.(issue);
      },
    });
  }

  private context() {
    if (!this.root) {
      const owner = object(this.rest.get(`users/${this.config.owner}`).body);
      if (
        String(owner.login).toLowerCase() !== this.config.owner.toLowerCase() ||
        !["User", "Organization"].includes(String(owner.type))
      )
        throw new Error("REST Project owner identity mismatch");
      const numericOwner = positive(owner.id);
      const kind = owner.type === "User" ? "users" : "orgs";
      this.root = `${kind}/${this.config.owner}/projectsV2/${this.config.project.number}`;
      this.aliases = [
        `/${this.root}`,
        `/${owner.type === "User" ? "user" : "organizations"}/${numericOwner}/projectsV2/${this.config.project.number}`,
      ];
    }
    const project = object(this.rest.get(this.root).body);
    if (
      project.number !== this.config.project.number ||
      typeof project.node_id !== "string" ||
      !project.node_id ||
      (this.projectNode !== undefined && project.node_id !== this.projectNode) ||
      String(object(project.owner).login).toLowerCase() !== this.config.owner.toLowerCase() ||
      project.closed_at !== null ||
      typeof project.updated_at !== "string"
    )
      throw new Error("REST Project identity or revision mismatch");
    this.projectNode = project.node_id;
    if (!this.fields || this.fieldsRevision !== project.updated_at) {
      const result = this.rest.pages(
        `${this.root}/fields?per_page=100`,
        this.aliases.map((path) => `${path}/fields`),
      );
      const names = new Set<string>();
      this.fields = result.rows.map((field) => {
        if (typeof field.name !== "string" || names.has(field.name))
          throw new Error("Duplicate REST Project field name");
        names.add(field.name);
        const options = new Map<string, string>();
        if (field.data_type === "single_select") {
          if (!Array.isArray(field.options)) throw new Error("Missing REST Project options");
          const optionIds = new Set<string>();
          for (const raw of field.options) {
            const option = object(raw),
              name = object(option.name).raw;
            if (
              typeof name !== "string" ||
              typeof option.id !== "string" ||
              options.has(name) ||
              optionIds.has(option.id)
            )
              throw new Error("Malformed or duplicate REST Project option");
            options.set(name, option.id);
            optionIds.add(option.id);
          }
        }
        return { id: positive(field.id), node: String(field.node_id), name: field.name, options };
      });
      this.fieldsRevision = project.updated_at;
    }
    return { root: this.root, project, fields: this.fields };
  }

  private activeItems(target?: string) {
    const before = this.context();
    const result = this.rest.pages(
      `${before.root}/items?per_page=100`,
      this.aliases.map((path) => `${path}/items`),
    );
    const after = this.context();
    for (const item of result.rows) {
      if (item.project_url !== `https://api.github.com/${before.root}` || item.archived_at !== null)
        throw new Error("REST active membership scope mismatch");
      positive(item.id);
      if (typeof object(item.content).node_id !== "string")
        throw new Error("Redacted REST Project membership");
    }
    // Positive membership is re-read by exact item ID before any field update.
    // A negative result still requires a stable complete traversal before add.
    if (
      before.project.updated_at !== after.project.updated_at &&
      !(target && result.rows.some((item) => object(item.content).node_id === target))
    )
      throw new Error("REST Project changed during negative active membership pagination");
    return result.rows;
  }

  override ensureIssueItem(contentId: string) {
    const number = this.created.get(contentId);
    if (number === undefined)
      throw new Error(
        "REST creation requires a current creation receipt; historical recovery needs archived-membership validation",
      );
    const matches = this.activeItems(contentId).filter(
      (item) => object(item.content).node_id === contentId,
    );
    if (matches.length > 1) throw new Error("Duplicate active REST Project membership");
    let item = matches[0];
    if (!item) {
      const { root } = this.context();
      const [owner, repo] = this.config.repository.split("/");
      // A failed/ambiguous POST is never retried here. The caller retains its
      // already-created issue receipt for explicit membership recovery.
      const response = this.rest.write("POST", `${root}/items`, {
        type: "Issue",
        owner,
        repo,
        number,
      });
      if (response.status !== 201) throw new Error("REST Project add was not confirmed");
      item = object(object(response.body).value);
    }
    const content = object(item.content);
    if (
      typeof item.node_id !== "string" ||
      item.archived_at !== null ||
      content.node_id !== contentId ||
      content.number !== number ||
      item.project_url !== `https://api.github.com/${this.root}` ||
      item.content_type !== "Issue" ||
      content.html_url !== `https://github.com/${this.config.repository}/issues/${number}`
    )
      throw new Error("REST Project add returned a different issue or archived membership");
    this.items.set(item.node_id, { id: positive(item.id), content: contentId });
    return { id: item.node_id };
  }

  private readItem(reference: string) {
    const binding = this.items.get(reference);
    if (!binding) throw new Error("REST readback requires the exact newly created item identity");
    const { root, fields } = this.context();
    const item = object(
      this.rest.get(
        `${root}/items/${binding.id}?fields=${fields.map((field) => field.id).join(",")}`,
      ).body,
    );
    const content = object(item.content);
    if (
      item.node_id !== reference ||
      item.id !== binding.id ||
      item.project_url !== `https://api.github.com/${root}` ||
      item.archived_at !== null ||
      content.node_id !== binding.content ||
      item.content_type !== "Issue" ||
      !this.created.has(binding.content) ||
      content.number !== this.created.get(binding.content) ||
      content.html_url !==
        `https://github.com/${this.config.repository}/issues/${Number(content.number)}` ||
      !Array.isArray(item.fields)
    )
      throw new Error("REST exact Project readback identity mismatch");
    const observed = new Map<string, string | null>();
    for (const raw of item.fields) {
      const value = object(raw),
        field = fields.find((entry) => entry.id === value.id);
      if (!field || value.name !== field.name || observed.has(field.name))
        throw new Error("Unknown or duplicate REST readback field");
      if (field.options.size) {
        const option = value.value === null ? null : object(value.value);
        const name = option === null ? null : object(option.name).raw;
        if (name !== null && (typeof name !== "string" || field.options.get(name) !== option?.id))
          throw new Error("REST readback option identity mismatch");
        observed.set(field.name, name);
      } else observed.set(field.name, null);
    }
    if (observed.size !== fields.length) throw new Error("REST readback omitted requested fields");
    return { item, content, observed, fields, root, binding };
  }

  override setItemFields(itemId: string, values: Readonly<Record<string, string>>) {
    this.fields = undefined;
    const before = this.readItem(itemId);
    const updates = Object.entries(values).map(([name, value]) => {
      const field = before.fields.find((entry) => entry.name === name),
        option = field?.options.get(value);
      if (!field || !option) throw new Error("Unknown REST intake field or option");
      const current = before.observed.get(name);
      if (current !== null && current !== value)
        throw new Error("Preserve concurrently assigned Project planning");
      return { id: field.id, value: option };
    });
    this.rest.write("PATCH", `${before.root}/items/${before.binding.id}`, { fields: updates });
    const after = this.readItem(itemId);
    for (const [name, value] of Object.entries(values))
      if (after.observed.get(name) !== value)
        throw new Error("REST intake Project field readback mismatch");
    for (const [name, value] of before.observed)
      if (!(name in values) && after.observed.get(name) !== value)
        throw new Error("Unrequested Project planning changed during REST intake");
  }

  override directProjectItem(reference: string): RoadmapIssueItem & { id: string } {
    const { item, content, observed } = this.readItem(reference);
    if (
      typeof content.title !== "string" ||
      !("body" in content) ||
      (content.body !== null && typeof content.body !== "string") ||
      typeof content.updated_at !== "string" ||
      !["open", "closed"].includes(String(content.state))
    )
      throw new Error("Incomplete REST issue content readback");
    return {
      id: reference,
      isArchived: false,
      rest_id: item.id,
      content: {
        id: String(content.node_id),
        number: Number(content.number),
        type: "Issue",
        __typename: "Issue",
        title: content.title,
        body: content.body ?? "",
        url: String(content.html_url),
        state: String(content.state).toUpperCase(),
        updatedAt: content.updated_at,
      },
      fieldValues: [...observed]
        .filter(([, value]) => value !== null)
        .map(([name, value]) => ({ field: { name }, name: value })),
    };
  }
}
