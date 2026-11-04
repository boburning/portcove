import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { RestInventoryReader } from "./github-rest-inventory.mts";
import { isRecord } from "./runtime-values.mts";
import { createGitHubClient } from "./github-client.mts";
import { RestInventoryTransport } from "./github-rest-inventory.mts";
import {
  collectRestRepositoryIssueInventory,
  requireRepositoryIssueInventory,
} from "./repository-issue-inventory.mts";
import { RestPortIntakeClient } from "./roadmap-rest-intake.mts";
import { validateConfig } from "./roadmap.mts";
import { renderPortIssueBody } from "./roadmap-issue.mts";

function response(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return { status, body, headers: new Map(Object.entries(headers)) };
}
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
const base = "https://api.github.com";

await test("REST pagination rejects changed origin, filters, duplicate parameters, skipped pages and loops", async () => {
  const path = "/repos/example/repo/issues";
  for (const next of [
    `https://other.example${path}?sort=created&page=2`,
    `${base}${path}?sort=updated&page=2`,
    `${base}${path}?sort=created&since=2026-01-01&page=2`,
    `${base}${path}?sort=created&page=2&page=3`,
    `${base}${path}?sort=created&page=3`,
    `${base}${path}?sort=created`,
  ]) {
    const api: RestInventoryReader = async () =>
      response([{ node_id: "one" }], { link: `<${next}>; rel="next"` });
    await assert.rejects(() =>
      new RestInventoryTransport(api).pages(`${path}?sort=created`, [path]),
    );
  }
});

await test("REST pagination follows identity-checked aliases and refuses duplicate IDs or malformed pages", async () => {
  for (const malformed of [null, {}, [{ node_id: "one" }]]) {
    let calls = 0;
    const api: RestInventoryReader = async () =>
      ++calls === 1
        ? response([{ node_id: "one" }], {
            link: `<${base}/user/1/projectsV2/1/items?after=next&per_page=100>; rel="next"`,
          })
        : response(malformed);
    await assert.rejects(() =>
      new RestInventoryTransport(api).pages("users/example/projectsV2/1/items?per_page=100", [
        "/users/example/projectsV2/1/items",
        "/user/1/projectsV2/1/items",
      ]),
    );
  }
  const api: RestInventoryReader = async () => response([]);
  assert.deepEqual(
    (
      await new RestInventoryTransport(api).pages("repos/example/repo/issues", [
        "/repos/example/repo/issues",
      ])
    ).rows,
    [],
  );
});

await test("REST conditional pages require a live304 and drop obsolete validators after200", async () => {
  const requests: Readonly<Record<string, string>>[] = [];
  let call = 0;
  const link = `<${base}/items?after=next>; rel="next"`;
  const rest = new RestInventoryTransport(async (_endpoint, headers) => {
    requests.push(headers);
    call++;
    return call === 1
      ? response([{ node_id: "old" }], { etag: "old-etag", link })
      : response([{ node_id: "new" }], { link });
  });
  await rest.get("items");
  await rest.get("items");
  await rest.get("items");
  assert.equal(requests[1]?.["If-None-Match"], "old-etag");
  assert(!requests[2]?.["If-None-Match"]);
  let hits = 0;
  const cached = new RestInventoryTransport(async () =>
    ++hits === 1
      ? response([{ node_id: "old" }], { etag: "tag", link })
      : response(null, { etag: "tag", link }, 304),
  );
  assert.deepEqual((await cached.get("items")).body, (await cached.get("items")).body);
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
  const invoke = async (method: "GET" | "POST" | "PATCH", endpoint: string, supplied?: unknown) => {
    const url = new URL(endpoint, `${base}/`),
      path = url.pathname.slice(1);
    if (method !== "GET") {
      assert(isRecord(supplied));
      const body = supplied;
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
  };
  const api = { read: async (endpoint: string) => invoke("GET", endpoint), write: invoke };
  const client = new RestPortIntakeClient(config, api);
  const input = {
    title: "Example",
    upstream: "https://github.com/example/project",
    portKey: "example-game-project",
  };
  if (options.duplicate) rows[0]!.body = renderPortIssueBody(input);
  return { client, input, writes, rows, api };
}

await test("REST repository proof covers closed issues, rejects partial/drifting reads and binds its reader", async () => {
  const good = fixture();
  const inventory = await good.client.repositoryIssues();
  assert.equal(inventory.evidence.source, "rest");
  assert.equal(inventory.issues[0]?.state, "CLOSED");
  assert.equal(requireRepositoryIssueInventory(inventory, good.client), inventory);
  assert.throws(() => requireRepositoryIssueInventory(inventory, fixture().client));
  for (const options of [{ partial: true }, { changed: true }])
    await assert.rejects(() => fixture(options).client.repositoryIssues());
  await assert.rejects(() =>
    collectRestRepositoryIssueInventory(
      good.client,
      new RestInventoryTransport(async () => response({})),
    ),
  );
});

await test("normal canonical intake completes viaREST with exact neutral Project readback", async () => {
  const { client, input, writes } = fixture();
  let receipt = false;
  const result = await client.createPortIssue({
    ...input,
    onIssueCreated: () => {
      receipt = true;
    },
  });
  assert.ok(receipt);
  assert.equal(result.number, 2);
  const observed = await client.directProjectItem(result.itemId);
  assert.equal(observed.content?.number, 2);
  assert.equal(
    observed.fieldValues?.find((field) => field.field?.name === "Target release")?.name,
    "Unscheduled",
  );
  assert.deepEqual(
    writes.map((write) => write.method),
    ["POST", "POST", "PATCH"],
  );
  await assert.rejects(() => client.ensureIssueItem("historical-issue"), /historical recovery/u);
  await assert.rejects(() => client.repositoryIssues({ projectMemberships: true }), /archived/u);
});

await test("REST intake awaits durable issue receipt before Project mutation", async () => {
  const { client, input, writes } = fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = client.createPortIssue({
    ...input,
    onIssueCreated: async () => {
      enter();
      await gate;
    },
  });
  await entered;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1, "only issue creation can precede durable receipt completion");
  } finally {
    release();
    await pending;
  }
  assert.equal(writes.length, 3);
});

await test("failed asynchronous issue receipt leaves creation observable without Project writes or replay", async () => {
  const { client, input, writes } = fixture();
  await assert.rejects(
    client.createPortIssue({
      ...input,
      onIssueCreated: async () => {
        await Promise.resolve();
        throw new Error("Durable receipt write failed");
      },
    }),
    /Durable receipt write failed/u,
  );
  assert.equal(writes.length, 1);
  const observed = await client.repositoryIssues();
  assert.equal(observed.issues.filter((issue) => issue.number === 2).length, 1);
});

await test("production REST SDK adapter performs inventory, creation and exact readback without CLI emulation", async () => {
  const source = fixture();
  const observations: string[] = [];
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token: "ghs_SYNTHETIC_ONLY" },
    deadline: performance.now() + 5000,
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      const endpoint = url.pathname.slice(1) + url.search;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-github-api-version"), "2026-03-10");
      assert(headers.has("authorization"));
      observations.push(`${init?.method} ${url.pathname}`);
      let result;
      if (init?.method === "GET") result = await source.api.read(endpoint);
      else {
        assert(init?.method === "POST" || init?.method === "PATCH");
        assert(typeof init.body === "string");
        const body: unknown = JSON.parse(init.body);
        result = await source.api.write(init.method, endpoint, body);
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json", ...Object.fromEntries(result.headers) },
      });
    },
  });
  const client = RestPortIntakeClient.fromSDK(config, sdk);
  let receipt = false;
  const created = await client.createPortIssue({
    ...source.input,
    onIssueCreated: () => {
      receipt = true;
    },
  });
  assert(receipt);
  assert.equal((await client.directProjectItem(created.itemId)).content?.number, 2);
  assert(observations.includes(`GET /repos/${config.repository}/issues`));
  assert.equal(source.writes.filter((value) => value.method === "POST").length, 2);
});

await test("REST duplicate, ambiguous-add, wrong-project and planning conflicts preserve write boundaries", async () => {
  const duplicate = fixture({ duplicate: true });
  await assert.rejects(() => duplicate.client.createPortIssue(duplicate.input), /durable issue/u);
  assert.equal(duplicate.writes.length, 0);
  for (const options of [{ ambiguous: true }, { wrongProject: true }, { planningConflict: true }]) {
    const setup = fixture(options);
    let created = 0;
    await assert.rejects(() =>
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

await test("board activity preserves exact positive membership but invalidates a negative add", async () => {
  const positive = fixture({ autoAdd: true, projectChanged: true });
  const created = await positive.client.createPortIssue(positive.input);
  assert.equal((await positive.client.directProjectItem(created.itemId)).content?.number, 2);
  assert.deepEqual(
    positive.writes.map((write) => write.method),
    ["POST", "PATCH"],
  );
  const negative = fixture({ projectChanged: true });
  await assert.rejects(
    () => negative.client.createPortIssue(negative.input),
    /negative active membership/u,
  );
  assert.deepEqual(
    negative.writes.map((write) => write.method),
    ["POST"],
  );
});

await test("REST issue inventory ignores PR-only edits but refuses creations and real-issue drift", async () => {
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
    const read: RestInventoryReader = async (endpoint) => {
      const url = new URL(endpoint, base + "/");
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
    };
    const client = new RestPortIntakeClient(config, {
      read,
      write: async () => {
        throw new Error("unexpected write");
      },
    });
    if (mode === "pr-edits" || mode === "all-prs") {
      const result = await client.repositoryIssues();
      assert.equal(result.issues.length, mode === "all-prs" ? 0 : 1);
      assert.ok(markerPages >= 6, "walk through every PR-only prefix page");
    } else
      await assert.rejects(
        () => client.repositoryIssues(),
        mode === "loop" ? /skipped a page/u : /changed/u,
      );
  }
});

await test("REST endpoints omitting Link on304 use complete unconditional pages afterward", async () => {
  const requests: Readonly<Record<string, string>>[] = [];
  const link = `<${base}/items?after=next>; rel="next"`;
  const rest = new RestInventoryTransport(async (_endpoint, headers) => {
    requests.push(headers);
    return requests.length === 2
      ? response(null, { etag: "tag" }, 304)
      : response([{ node_id: "one" }], { etag: "tag", link });
  });
  await rest.get("items");
  await rest.get("items");
  await rest.get("items");
  assert.equal(requests.length, 4);
  assert.equal(requests[1]?.["If-None-Match"], "tag");
  assert(requests.slice(2).every((headers) => !headers["If-None-Match"]));
});

void test("inventory recovery cannot renew a failed page's SDK attempt allowance", async () => {
  let dispatched = 0;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 15000,
    random: () => 0,
    fetch: async () => {
      dispatched++;
      return new Response("unavailable", { status: 503 });
    },
  });
  const inventory = RestInventoryTransport.fromSDK(client);
  await assert.rejects(inventory.get("repos/example/repo/issues"));
  await assert.rejects(inventory.get("repos/example/repo/issues"));
  assert.equal(dispatched, 3);
});
