# README screenshots

The [Library](library.png) and [game details](game-details.png) screenshots were
captured on November 18, 2026, from the [Desktop source at 1b35937](https://github.com/boburning/portcove/tree/1b3593713ab34abe99844f368d6504cf49be24ed/apps/desktop).
They show the desktop interface rendered in Chromium with a simulated local
library. The [comparison scene](../../../apps/desktop/src/dev-scenarios/interactive/comparison-scene.ts)
supplies the fictional games and geometric cover images.

## Reproduce the views

1. From the repository root, start the frontend with `node scripts/dev-storage.mts run -- pnpm --dir apps/desktop dev`.
2. Open `/scenarios.html?mode=interactive&journey=comparison&embed=1` on the local development server. Use a dark color scheme and a 1440 × 900 viewport at 100% zoom. Embedded mode hides the scenario controls.
3. In **Library**, use the heart on **Harbor desktop port** and on Collection ports **3**, **4**, **5**, **6**, and **11**. The six titles include the **Orchard Quest** entry with **Game files missing**. Open **Favorites** with the **Covers** view and **Title A–Z** sort selected.
4. Open the **Harbor Adventure** card for **Harbor desktop port** and capture **Overview**.

When the layout changes, repeat these steps against the new revision and update the date and source link.
