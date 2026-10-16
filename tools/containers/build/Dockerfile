FROM ghcr.io/voidzero-dev/vite-plus:1.2.0@sha256:72da2a35e67d6d73fb5110466ee21741c847a1929777e6ca1499862d2f0db5e8 AS vite
FROM rust:1.98.1-slim-bookworm@sha256:ff521445a372125ed4f76e1453a1f8098f2d05332d1601d30db1c1f62757e730 AS rust
FROM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401

# No browser stage or browser install. Ubuntu 22.04 is the selected release-build baseline.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git build-essential python3 pkg-config xz-utils file libicu70 libunwind8 && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 1000 --create-home --shell /bin/bash vp && mkdir /workspace /portcove && chown vp:vp /workspace /portcove
COPY --from=vite --chown=vp:vp /home/vp/.vite-plus /home/vp/.vite-plus
COPY --from=rust --chown=vp:vp /usr/local/rustup /opt/rustup
COPY --from=rust --chown=vp:vp /usr/local/cargo /home/vp/.cargo
# PowerShell's published Linux archive, checked against the official release asset digest.
ARG POWERSHELL_VERSION=7.6.6
ARG POWERSHELL_SHA256=ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc
RUN curl --fail --location --max-time 300 -o /tmp/powershell.tar.gz https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz && echo "${POWERSHELL_SHA256}  /tmp/powershell.tar.gz" | sha256sum --check - && mkdir -p /opt/microsoft/powershell/7 && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 && chmod +x /opt/microsoft/powershell/7/pwsh && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh && rm /tmp/powershell.tar.gz
ENV CI=true VP_GIT_HOOKS=0 VP_HOME=/home/vp/.vite-plus RUSTUP_HOME=/opt/rustup CARGO_HOME=/home/vp/.cargo APPIMAGE_EXTRACT_AND_RUN=1
ENV PATH=/home/vp/.vite-plus/bin:/home/vp/.cargo/bin:$PATH
# Extracted byte-for-byte from the selected commit, not from dirty current work.
COPY linux-prerequisites.sh /portcove/linux-prerequisites.sh
RUN bash /portcove/linux-prerequisites.sh --include-rpm --install-timeout-seconds=2700
RUN dpkg-query -W > /portcove/installed-system-packages.txt
COPY --chown=vp:vp source.bundle /portcove/source.bundle
USER vp
ARG SOURCE_COMMIT
ARG SOURCE_TREE
RUN git clone --branch container-selected /portcove/source.bundle /workspace
WORKDIR /workspace
RUN test "$(git rev-parse HEAD)" = "$SOURCE_COMMIT" && test "$(git rev-parse 'HEAD^{tree}')" = "$SOURCE_TREE"
# These commands also prove copied tools execute against Ubuntu 22.04's glibc.
RUN rustc --version && pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
RUN vp install --frozen-lockfile
RUN rustup component add rustfmt clippy rust-analyzer && cargo fetch --locked --target x86_64-unknown-linux-gnu
RUN pnpm list --recursive --depth Infinity --json > /portcove/installed-npm-packages.json
RUN node -e "const {execFileSync}=require('node:child_process'); require('node:fs').writeFileSync('/portcove/tool-versions.json', JSON.stringify(Object.fromEntries(['node','pnpm','vp','rustc','cargo','pwsh'].map(command => [command,execFileSync(command,['--version'],{encoding:'utf8'}).trim()]))));"
COPY --chown=vp:vp container-entry.mts container-source.mts container-build-policy.mts runtime-values.mts /portcove/
RUN node /portcove/container-source.mts "$SOURCE_COMMIT" "$SOURCE_TREE"
ARG WORKSPACE_OWNER
ARG PREPARATION
LABEL io.portcove.tool="build-v1" io.portcove.workspace=$WORKSPACE_OWNER io.portcove.preparation=$PREPARATION io.portcove.source=$SOURCE_COMMIT io.portcove.tree=$SOURCE_TREE
ENTRYPOINT ["node", "/portcove/container-entry.mts"]
