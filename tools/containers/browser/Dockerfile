FROM ghcr.io/voidzero-dev/vite-plus:1.4.0@sha256:5dfa2031f7d014b6376407fd99e0747bed329d792c79c184a65ec9a0765bee0e

ARG SOURCE_COMMIT
ARG SOURCE_TREE
ENV CI=true PORTCOVE_CONTAINER_GUEST=1 VP_GIT_HOOKS=0
USER root
RUN mkdir /workspace /portcove && chown vp:vp /workspace /portcove
COPY --chown=vp:vp source.bundle /portcove/source.bundle
USER vp
RUN git clone --branch container-selected /portcove/source.bundle /workspace
WORKDIR /workspace
RUN test "$(git rev-parse HEAD)" = "$SOURCE_COMMIT" && test "$(git rev-parse 'HEAD^{tree}')" = "$SOURCE_TREE"
# The complete committed tree includes every manifest, patch and lifecycle input.
RUN vp install --frozen-lockfile
RUN node apps/desktop/scripts/browser-package-compatibility.mts
USER root
# Use the installed, lockfile-selected Playwright package's own library list.
RUN node apps/desktop/node_modules/playwright/cli.js install-deps chromium
RUN SUDO_FORCE_REMOVE=yes apt-get purge -y sudo && rm -rf /var/lib/apt/lists/* /etc/sudoers.d
RUN dpkg-query -W > /portcove/installed-system-packages.txt
USER vp
RUN node apps/desktop/scripts/browser-runtime.mts bootstrap
RUN pnpm list --recursive --depth Infinity --json > /portcove/installed-npm-packages.json
RUN node -e "const {execFileSync}=require('node:child_process'); require('node:fs').writeFileSync('/portcove/tool-versions.json', JSON.stringify(Object.fromEntries(['node','pnpm','vp'].map(command => [command,execFileSync(command,['--version'],{encoding:'utf8'}).trim()]))));"
COPY --chown=vp:vp container-entry.mts container-source.mts runtime-values.mts /portcove/
RUN node /portcove/container-source.mts "$SOURCE_COMMIT" "$SOURCE_TREE"
ARG WORKSPACE_OWNER
ARG PREPARATION
LABEL io.portcove.tool="browser-v1" io.portcove.workspace=$WORKSPACE_OWNER io.portcove.preparation=$PREPARATION io.portcove.source=$SOURCE_COMMIT io.portcove.tree=$SOURCE_TREE
ENTRYPOINT ["node", "/portcove/container-entry.mts"]
