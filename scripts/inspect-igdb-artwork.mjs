import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Maintainer-only discovery. Never place the Twitch secret or app token in the
// catalog, a desktop bundle, a command argument, or diagnostic output.
const credentialsPath = process.argv[2];
if (!credentialsPath) {
  throw new Error("Pass the path to a private JSON file with client_id and client_secret.");
}
const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
if (!credentials.client_id || !credentials.client_secret) {
  throw new Error("The private IGDB credentials file is incomplete.");
}

const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
  method: "POST",
  redirect: "error",
  body: new URLSearchParams({
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    grant_type: "client_credentials",
  }),
  signal: AbortSignal.timeout(15000),
});
if (!tokenResponse.ok) throw new Error(`Twitch token request failed (${tokenResponse.status}).`);
const token = (await tokenResponse.json()).access_token;
if (typeof token !== "string" || !token) throw new Error("Twitch returned no app token.");

async function gameForSlug(slug) {
  const response = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    redirect: "error",
    headers: {
      "Client-ID": credentials.client_id,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: `fields id,name,slug,cover.id,cover.image_id; where slug = "${slug}"; limit 10;`,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`IGDB games request failed (${response.status}).`);
  const matches = await response.json();
  if (!Array.isArray(matches)) throw new Error("IGDB returned an unexpected games response.");
  return Promise.all(
    matches.map(async ({ id, name, slug: actualSlug, cover }) => {
      let imageSha256 = null;
      if (cover?.image_id && /^[a-z0-9]+$/.test(cover.image_id)) {
        const image = await fetch(
          `https://images.igdb.com/igdb/image/upload/t_cover_big/${cover.image_id}.jpg`,
          { redirect: "error", signal: AbortSignal.timeout(15000) },
        );
        if (image.ok && image.headers.get("content-type")?.startsWith("image/jpeg")) {
          const bytes = await readBounded(image, 16 * 1024 * 1024);
          if (bytes?.length) imageSha256 = createHash("sha256").update(bytes).digest("hex");
        }
      }
      return {
        id,
        name,
        slug: actualSlug,
        cover_id: cover?.id ?? null,
        image_id: cover?.image_id ?? null,
        image_sha256: imageSha256,
      };
    }),
  );
}

async function readBounded(response, maximum) {
  if (Number(response.headers.get("content-length")) > maximum || !response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, length);
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

const port = await gameForSlug("ship-of-harkinian");
const underlyingGame = await gameForSlug("the-legend-of-zelda-ocarina-of-time");
const uniqueCover = (matches) =>
  matches.length === 1 && matches[0].cover_id && matches[0].image_sha256 ? matches[0] : null;
const selectedPort = uniqueCover(port);
const selectedGame = selectedPort ? null : uniqueCover(underlyingGame);
const selected = selectedPort ?? selectedGame;
process.stdout.write(
  `${JSON.stringify(
    {
      port,
      underlying_game: underlyingGame,
      selected_mapping: selected
        ? {
            game_id: selected.id,
            cover_id: selected.cover_id,
            image_id: selected.image_id,
            image_sha256: selected.image_sha256,
            game_slug: selected.slug,
            match_kind: selectedPort ? "port" : "underlying-game",
          }
        : null,
    },
    null,
    2,
  )}\n`,
);
