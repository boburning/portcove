import { createGitHubClient } from "../github-client.mts";
import type { GitHubClientOptions } from "../github-client.mts";

/** Real locked SDK with a controlled HTTP boundary. Operation-level domain tests
 * should provide asynchronous domain fakes instead when HTTP is irrelevant. */
export async function fixtureGitHub(
  respond: (request: {
    method: string;
    endpoint: string;
    headers: Headers;
    body: unknown;
  }) => unknown,
  options: Pick<GitHubClientOptions, "reserve"> = {},
) {
  return await createGitHubClient({
    ...options,
    credential: { kind: "anonymous" },
    deadline: performance.now() + 60_000,
    random: () => 0,
    sleep: async () => {},
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const result = await respond({
        method: init?.method ?? "GET",
        endpoint: url.pathname.slice(1) + url.search,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return result instanceof Response ? result : Response.json(result);
    },
  });
}
