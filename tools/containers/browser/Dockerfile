ARG BROWSER_SYSTEM_STAGE=system

FROM ghcr.io/voidzero-dev/vite-plus:1.5.0@sha256:cce163cdf4cf3fff928925e03a815910be14d34c355fe40b4e79e766fe368f63 AS base

ENV CI=true PORTCOVE_CONTAINER_GUEST=1 VP_GIT_HOOKS=0
USER root
RUN mkdir /workspace /portcove && chown vp:vp /workspace /portcove

FROM base AS workspace
ARG SOURCE_COMMIT
ARG SOURCE_TREE
USER vp
RUN --mount=type=bind,source=source.bundle,target=/portcove/source.bundle \
    git clone --branch container-selected /portcove/source.bundle /workspace
WORKDIR /workspace
RUN test "$(git rev-parse HEAD)" = "$SOURCE_COMMIT" && test "$(git rev-parse 'HEAD^{tree}')" = "$SOURCE_TREE"
# Install the complete committed workspace before resolving the dependency tool.
RUN vp install --frozen-lockfile
RUN node apps/desktop/scripts/browser-package-compatibility.mts
RUN mkdir /portcove/browser-deps \
    && cp "$(node -p 'process.execPath')" /portcove/browser-deps/node \
    && cp -a "$(node -p 'require("node:path").dirname(require("node:module").createRequire(require.resolve("playwright/package.json", { paths: ["./apps/desktop"] })).resolve("playwright-core/package.json"))')" /portcove/browser-deps/playwright-core

FROM base AS system
# The mount checksum covers only the frozen installer bytes and its Node runtime.
RUN --mount=type=bind,from=workspace,source=/portcove/browser-deps,target=/opt/browser-deps \
    /opt/browser-deps/node /opt/browser-deps/playwright-core/cli.js install-deps chromium \
    && SUDO_FORCE_REMOVE=yes apt-get purge -y sudo \
    && rm -rf /var/lib/apt/lists/* /etc/sudoers.d \
    && test ! -e /usr/bin/sudo \
    && dpkg-query -W > /portcove/installed-system-packages.txt

FROM ${BROWSER_SYSTEM_STAGE} AS workspace-smoke
COPY --link --chown=1000:1000 --from=workspace /home/vp/ /home/vp/
COPY --link --chown=1000:1000 --from=workspace /workspace/ /workspace/
ARG SOURCE_COMMIT
ARG SOURCE_TREE
USER vp
WORKDIR /workspace
COPY --chown=vp:vp container-entry.mts container-source.mts runtime-values.mts /portcove/
RUN test "$(id -u)" = 1000 && test "$(id -g)" = 1000 && test -w /workspace && test -w /home/vp \
    && node /portcove/container-source.mts "$SOURCE_COMMIT" "$SOURCE_TREE"

FROM workspace-smoke
RUN node apps/desktop/scripts/browser-runtime.mts bootstrap
RUN pnpm list --recursive --depth Infinity --json > /portcove/installed-npm-packages.json
RUN node -e "const {execFileSync}=require('node:child_process'); require('node:fs').writeFileSync('/portcove/tool-versions.json', JSON.stringify(Object.fromEntries(['node','pnpm','vp'].map(command => [command,execFileSync(command,['--version'],{encoding:'utf8'}).trim()]))));"
RUN node /portcove/container-source.mts "$SOURCE_COMMIT" "$SOURCE_TREE"
ARG WORKSPACE_OWNER
ARG PREPARATION
LABEL io.portcove.tool="browser-v1" io.portcove.workspace=$WORKSPACE_OWNER io.portcove.preparation=$PREPARATION io.portcove.source=$SOURCE_COMMIT io.portcove.tree=$SOURCE_TREE
ENTRYPOINT ["node", "/portcove/container-entry.mts"]
