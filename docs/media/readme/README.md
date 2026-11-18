# README screenshots

The [Library](library.png) and [game details](game-details.png) screenshots were
captured on November 18, 2026, from the [Desktop source at 1b35937](https://github.com/boburning/portcove/tree/1b3593713ab34abe99844f368d6504cf49be24ed/apps/desktop).
They show the desktop interface rendered in Chromium with a simulated local
library. The [comparison scene](../../../apps/desktop/src/dev-scenarios/interactive/comparison-scene.ts)
supplies the fictional games and geometric cover images.

## Refresh the screenshots

When a change affects the Library cards, sidebar, or game details, compare the
two screenshots with the new interface. The [Desktop change history](https://github.com/boburning/portcove/commits/main/apps/desktop/src)
shows what has changed in the frontend.

After the [frontend setup](../../DEVELOPMENT-TOOLS.md#frontend-workflow), install
the repository’s Chromium build once with `pnpm --dir apps/desktop browser:bootstrap`.
Run this command from the repository root to capture both views.

```sh
node scripts/dev-storage.mts run --scope frontend -- node apps/desktop/scripts/capture-readme.mts
```

The command starts a local preview, marks six fictional games as favorites, and
opens the favorited Harbor Adventure port. It captures both views at 1440 × 900
in dark mode. It blocks external requests and checks the covers against the
fixture images.

Review both PNGs in the output directory. Check that every cover is fictional
and that the README captions and image descriptions match the controls on screen.
When refreshing the images, copy the pair into this folder and update the capture
date and source link above with the revision you reviewed.
