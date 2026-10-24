import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { GitHubApiClient } from "./github-api.mts";
import { RestInventoryTransport } from "./github-rest-inventory.mts";
import {
  collectRestRepositoryIssueInventory,
  requireRepositoryIssueInventory,
} from "./repository-issue-inventory.mts";
import { RestPortIntakeClient } from "./roadmap-rest-intake.mts";
import { renderPortIssueBody, validateConfig } from "./roadmap.mts";

function response(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return `HTTP/2.0 ${status}\r\n${Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("")}\r\n${status === 304 ? "" : JSON.stringify(body)}`;
}
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
const base = "https://api.github.com";

await test("REST pagination rejects changed origin, filters, duplicate parameters, skipped pages and loops", () => {
  const path = "/repos/example/repo/issues";
  for (const next of [
    `https://other.example${path}?sort=created&page=2`,
    `${base}${path}?sort=updated&page=2`,
    `${base}${path}?sort=created&since=2026-01-01&page=2`,
    `${base}${path}?sort=created&page=2&page=3`,
    `${base}${path}?sort=created&page=3`,
    `${base}${path}?sort=created`,
  ]) {
    const api = new GitHubApiClient(() =>
      response([{ node_id: "one" }], { link: `<${next}>; rel="next"` }),
    );
    assert.throws(() => new RestInventoryTransport(api).pages(`${path}?sort=created`, [path]));
  }
});

await test("REST pagination follows identity-checked aliases and refuses duplicate IDs or malformed pages", () => {
  for (const malformed of [null, {}, [{ node_id: "one" }]]) {
    let calls = 0;
    const api = new GitHubApiClient(() =>
      ++calls === 1
        ? response([{ node_id: "one" }], {
            link: `<${base}/user/1/projectsV2/1/items?after=next&per_page=100>; rel="next"`,
          })
        : response(malformed),
    );
    assert.throws(() =>
      new RestInventoryTransport(api).pages("users/example/projectsV2/1/items?per_page=100", [
        "/users/example/projectsV2/1/items",
        "/user/1/projectsV2/1/items",
      ]),
    );
  }
  const api = new GitHubApiClient(() => response([]));
  assert.deepEqual(
    new RestInventoryTransport(api).pages("repos/example/repo/issues", [
      "/repos/example/repo/issues",
    ]).rows,
    [],
  );
});

await test("REST conditional pages require a live304 and drop obsolete validators after200", () => {
  const requests: readonly string[][] = [];
  const writable = requests as string[][];
  let call = 0;
  const link = `<${base}/items?after=next>; rel="next"`;
  const api = new GitHubApiClient((args) => {
    writable.push([...args]);
    call++;
    if (call === 1) return response([{ node_id: "old" }], { etag: "old-etag", link });
    if (call === 2) return response([{ node_id: "new" }], { link });
    return response([{ node_id: "new" }], { link });
  });
  const rest = new RestInventoryTransport(api);
  rest.get("items");
  rest.get("items");
  rest.get("items");
  assert.ok(requests[1]?.includes("If-None-Match: old-etag"));
  assert.ok(!requests[2]?.some((argument) => argument.startsWith("If-None-Match:")));
  let hits = 0;
  const cached = new RestInventoryTransport(
    new GitHubApiClient(() =>
      ++hits === 1
        ? response([{ node_id: "old" }], { etag: "tag", link })
        : response(null, { etag: "tag", link }, 304),
    ),
  );
  assert.deepEqual(cached.get("items").body, cached.get("items").body);
  assert.equal(hits, 2);
});

function issue(number: number) {
  return {
    id: number,
    node_id: `I-${number}`,
    number,
    title: `issue${number}`,
    body: "body",
    state: "closed",
    html_url: `https://github.com/${config.repository}/issues/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
function fixture(
  options: {
    duplicate?: boolean;
    changed?: boolean;
    partial?: boolean;
    wrongProject?: boolean;
    ambiguous?: boolean;
    planningConflict?: boolean;
    autoAdd?: boolean;
    projectChanged?: boolean;
  } = {},
) {
  const rows = [issue(1)];
  const writes: { method: string; endpoint: string; body: Record<string, unknown> }[] = [];
  const defaults: Record<string, string> = {
    Status: "Inbox",
    Priority: "None",
    Horizon: "Someday",
    "Target release": "Unscheduled",
    "Work type": "Port",
    Workstream: "Port catalog",
    Platform: "Unknown",
    "Port stage": "Watchlist",
    Effort: "Unknown",
  };
  const fields = Object.entries(defaults).map(([name, value], index) => ({
    id: index + 1,
    node_id: `F-${index}`,
    name,
    data_type: "single_select",
    options: [{ id: `O-${index}`, name: { raw: value } }],
  }));
  const values = new Map<number, unknown>(fields.map((field) => [field.id, null]));
  const root = `users/${config.owner}/projectsV2/${config.project.number}`;
  let projectReads = 0;
  let current = rows[0]!,
    markerCalls = 0;
  const item = () => ({
    id: 100,
    node_id: "PVTI-new",
    project_url: `${base}/${options.wrongProject ? "users/other/projectsV2/1" : root}`,
    content_type: "Issue",
    archived_at: null,
    content: current,
    fields: fields.map((field) => ({
      ...field,
      value:
        options.planningConflict && field.name === "Status"
          ? { id: "foreign", name: { raw: "In progress" } }
          : values.get(field.id),
    })),
  });
  const api = new GitHubApiClient((args, input) => {
    assert.ok(!args.includes("graphql"), "intake must not invoke GraphQL");
    const endpoint = args[2] ?? "",
      method = args[args.indexOf("--method") + 1];
    const url = new URL(endpoint, `${base}/`),
      path = url.pathname.slice(1);
    if (method !== "GET") {
      const body = JSON.parse(input ?? "{}") as Record<string, unknown>;
      writes.push({ method: String(method), endpoint: path, body });
      if (path === `repos/${config.repository}/issues`) {
        current = {
          ...issue(2),
          title: String(body.title),
          body: String(body.body),
          state: "open",
        };
        rows.push(current);
        return response(current, {}, 201);
      }
      if (method === "POST" && path === `${root}/items`) {
        if (options.ambiguous) throw new Error("ambiguous provider write");
        return response({ value: item() }, {}, 201);
      }
      if (method === "PATCH" && path === `${root}/items/100`) {
        for (const update of body.fields as { id: number; value: string }[]) {
          const field = fields.find((entry) => entry.id === update.id)!;
          values.set(update.id, { id: update.value, name: { raw: field.options[0]!.name.raw } });
        }
        return response(item());
      }
      throw new Error(`Unexpected fixture write ${method} ${path}`);
    }
    if (path === `repos/${config.repository}`)
      return response({ id: 10, node_id: "repo", full_name: config.repository });
    if (path === `repos/${config.repository}/issues`) {
      if (url.searchParams.get("per_page") === "1") {
        markerCalls++;
        return response([
          { ...rows.at(-1)!, ...(options.changed && markerCalls > 2 ? { body: "changed" } : {}) },
        ]);
      }
      return response(options.partial ? [] : rows);
    }
    if (path === `users/${config.owner}`)
      return response({ id: 1, login: config.owner, type: "User" });
    if (path === root)
      return response({
        node_id: "PVT",
        number: config.project.number,
        owner: { login: config.owner },
        closed_at: null,
        updated_at: `2026-01-01T00:00:${String(options.projectChanged ? ++projectReads : 0).padStart(2, "0")}Z`,
      });
    if (path === `${root}/fields`) return response(fields);
    if (path === `${root}/items`) return response(options.autoAdd ? [item()] : []);
    if (path === `${root}/items/100`) return response(item());
    throw new Error(`Unexpected fixture GET ${path}`);
  });
  const client = new RestPortIntakeClient(config, api);
  const input = {
    title: "Example",
    upstream: "https://github.com/example/project",
    portKey: "example-game-project",
  };
  if (options.duplicate) rows[0]!.body = renderPortIssueBody(input);
  return { client, input, writes, rows, api };
}

await test("REST repository proof covers closed issues, rejects partial/drifting reads and binds its reader", () => {
  const good = fixture();
  const inventory = good.client.repositoryIssues();
  assert.equal(inventory.evidence.source, "rest");
  assert.equal(inventory.issues[0]?.state, "CLOSED");
  assert.equal(requireRepositoryIssueInventory(inventory, good.client), inventory);
  assert.throws(() => requireRepositoryIssueInventory(inventory, fixture().client));
  for (const options of [{ partial: true }, { changed: true }])
    assert.throws(() => fixture(options).client.repositoryIssues());
  assert.throws(() =>
    collectRestRepositoryIssueInventory(
      good.client,
      new RestInventoryTransport(new GitHubApiClient(() => response({}))),
    ),
  );
});

await test("normal canonical intake completes viaREST with exact neutral Project readback", () => {
  const { client, input, writes } = fixture();
  let receipt = false;
  const result = client.createPortIssue({
    ...input,
    onIssueCreated: () => {
      receipt = true;
    },
  });
  assert.ok(receipt);
  assert.equal(result.number, 2);
  const observed = client.directProjectItem(result.itemId);
  assert.equal(observed.content?.number, 2);
  assert.equal(
    observed.fieldValues?.find((field) => field.field?.name === "Target release")?.name,
    "Unscheduled",
  );
  assert.deepEqual(
    writes.map((write) => write.method),
    ["POST", "POST", "PATCH"],
  );
  assert.throws(() => client.ensureIssueItem("historical-issue"), /historical recovery/u);
  assert.throws(() => client.repositoryIssues({ projectMemberships: true }), /archived/u);
});

await test("REST duplicate, ambiguous-add, wrong-project and planning conflicts preserve write boundaries", () => {
  const duplicate = fixture({ duplicate: true });
  assert.throws(() => duplicate.client.createPortIssue(duplicate.input), /durable issue/u);
  assert.equal(duplicate.writes.length, 0);
  for (const options of [{ ambiguous: true }, { wrongProject: true }, { planningConflict: true }]) {
    const setup = fixture(options);
    let created = 0;
    assert.throws(() =>
      setup.client.createPortIssue({
        ...setup.input,
        onIssueCreated: () => {
          created++;
        },
      }),
    );
    assert.equal(created, 1);
    assert.equal(
      setup.writes.filter((write) => write.endpoint.endsWith("/items") && write.method === "POST")
        .length,
      1,
    );
    assert.equal(setup.writes.filter((write) => write.method === "PATCH").length, 0);
  }
});

await test("board activity preserves exact positive membership but invalidates a negative add", () => {
  const positive = fixture({ autoAdd: true, projectChanged: true });
  const created = positive.client.createPortIssue(positive.input);
  assert.equal(positive.client.directProjectItem(created.itemId).content?.number, 2);
  assert.deepEqual(
    positive.writes.map((write) => write.method),
    ["POST", "PATCH"],
  );
  const negative = fixture({ projectChanged: true });
  assert.throws(
    () => negative.client.createPortIssue(negative.input),
    /negative active membership/u,
  );
  assert.deepEqual(
    negative.writes.map((write) => write.method),
    ["POST"],
  );
});

await test("REST issue inventory ignores PR-only edits but refuses creations and real-issue drift", () => {
  for (const mode of [
    "pr-edits",
    "new-pr",
    "new-issue",
    "issue-body",
    "issue-title",
    "issue-state",
    "missing-marker",
    "all-prs",
    "loop",
  ] as const) {
    const existing = issue(1);
    const prs = [2, 3, 4].map((number) => ({
      ...issue(number),
      pull_request: {},
      html_url: `https://github.com/${config.repository}/pull/${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    }));
    const mainRows = mode === "all-prs" ? prs : [existing, ...prs];
    let createdReads = 0,
      markerPages = 0;
    const api = new GitHubApiClient((args) => {
      const url = new URL(args[2]!, base + "/");
      if (url.pathname === `/repos/${config.repository}`)
        return response({ id: 10, node_id: "repo", full_name: config.repository });
      if (url.searchParams.get("direction") === "asc") return response(mainRows);
      if (url.searchParams.get("sort") === "created") {
        createdReads++;
        if (createdReads === 2 && (mode === "new-pr" || mode === "new-issue"))
          return response([{ ...issue(5), created_at: "2026-01-05T00:00:00Z" }]);
        return response([
          {
            ...prs[2]!,
            ...(createdReads > 1
              ? {
                  body: "PR edited",
                  title: "new PR title",
                  state: "open",
                  updated_at: "2026-02-01T00:00:00Z",
                }
              : {}),
          },
        ]);
      }
      markerPages++;
      const page = Number(url.searchParams.get("page") ?? 1);
      const prefix: Record<string, unknown>[] = [...prs].reverse();
      if (mode !== "all-prs")
        prefix.push({
          ...existing,
          ...(mode === "missing-marker" ? { node_id: "missing" } : {}),
          ...(createdReads > 1
            ? mode === "issue-body"
              ? { body: "changed" }
              : mode === "issue-title"
                ? { title: "changed" }
                : mode === "issue-state"
                  ? { state: "open" }
                  : {}
            : {}),
        });
      const current = prefix[page - 1];
      const next =
        page < prefix.length
          ? `${base}/repos/${config.repository}/issues?state=all&sort=updated&direction=desc&per_page=1&page=${mode === "loop" ? page : page + 1}`
          : null;
      return response(current ? [current] : [], next ? { link: `<${next}>; rel="next"` } : {});
    });
    const client = new RestPortIntakeClient(config, api);
    if (mode === "pr-edits" || mode === "all-prs") {
      const result = client.repositoryIssues();
      assert.equal(result.issues.length, mode === "all-prs" ? 0 : 1);
      assert.ok(markerPages >= 6, "walk through every PR-only prefix page");
    } else
      assert.throws(
        () => client.repositoryIssues(),
        mode === "loop" ? /skipped a page/u : /changed/u,
      );
  }
});

await test("REST endpoints omitting Link on304 use complete unconditional pages afterward", () => {
  const requests: string[][] = [];
  const link = `<${base}/items?after=next>; rel="next"`;
  const rest = new RestInventoryTransport(
    new GitHubApiClient((args) => {
      requests.push([...args]);
      return requests.length === 2
        ? response(null, { etag: "tag" }, 304)
        : response([{ node_id: "one" }], { etag: "tag", link });
    }),
  );
  rest.get("items");
  rest.get("items");
  rest.get("items");
  assert.equal(requests.length, 4);
  assert.ok(requests[1]!.includes("If-None-Match: tag"));
  assert.ok(
    requests.slice(2).every((args) => !args.some((value) => value.startsWith("If-None-Match:"))),
  );
});
