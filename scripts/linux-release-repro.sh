#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/linux-release-repro.sh [installed|native-test|readiness]

Run release gates inside an Ubuntu container with Node from .nvmrc, tmux,
a non-root runner user, and no host AIMUX_* environment.

Modes:
  installed    Run yarn installed:gate and yarn installed:local-gate (default)
  native-test  Run yarn native:test
  readiness    Run yarn release:readiness
USAGE
}

MODE="${1:-installed}"
case "$MODE" in
  installed|native-test|readiness) ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER="${DOCKER:-/usr/local/bin/docker}"
if [ ! -x "$DOCKER" ]; then
  DOCKER="$(command -v docker || true)"
fi
if [ -z "$DOCKER" ] || [ ! -x "$DOCKER" ]; then
  echo "aimux: docker not found; expected /usr/local/bin/docker or docker on PATH" >&2
  exit 127
fi

NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
IMAGE="aimux-linux-release-repro:ubuntu24-node${NODE_VERSION}"
CONTAINER_ROOT="/work/aimux"
RUNNER_UID="${AIMUX_LINUX_REPRO_UID:-1001}"
RUNNER_GID="${AIMUX_LINUX_REPRO_GID:-1001}"

HOST_UNAME="$(uname -m)"
case "$HOST_UNAME" in
  arm64|aarch64) PLATFORM="linux/arm64" ;;
  x86_64|amd64) PLATFORM="linux/amd64" ;;
  *)
    echo "aimux: unsupported host architecture for Docker repro: $HOST_UNAME" >&2
    exit 1
    ;;
esac

TMPDIR="${TMPDIR:-/tmp}"
DOCKERFILE="$(mktemp "$TMPDIR/aimux-linux-release-repro.Dockerfile.XXXXXX")"
trap 'rm -f "$DOCKERFILE"' EXIT

cat > "$DOCKERFILE" <<'DOCKERFILE'
FROM ubuntu:24.04

ARG NODE_VERSION
ARG RUNNER_UID=1001
ARG RUNNER_GID=1001

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    lsof \
    openssh-client \
    pkg-config \
    procps \
    python3 \
    python3-venv \
    rsync \
    sudo \
    tmux \
    xz-utils \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${RUNNER_GID}" runner \
  && useradd --uid "${RUNNER_UID}" --gid "${RUNNER_GID}" --create-home --shell /bin/bash runner \
  && mkdir -p /work /tmp/runner-temp \
  && chown -R runner:runner /work /tmp/runner-temp

RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64) node_arch="x64" ;; \
    aarch64|arm64) node_arch="arm64" ;; \
    *) echo "unsupported container architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
  mkdir -p /opt/node; \
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
  rm -f /tmp/node.tar.xz; \
  PATH="/opt/node/bin:${PATH}" /opt/node/bin/corepack enable; \
  PATH="/opt/node/bin:${PATH}" /opt/node/bin/corepack prepare yarn@1.22.21 --activate

USER runner
ENV HOME=/home/runner
ENV PATH=/home/runner/.cargo/bin:/opt/node/bin:$PATH
ENV RUNNER_OS=Linux
ENV RUNNER_TEMP=/tmp/runner-temp
ENV CARGO_INCREMENTAL=0
ENV CARGO_TARGET_DIR=/tmp/aimux-cargo-target-linux-release-repro

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.92.0 --component clippy --component rustfmt

WORKDIR /work
DOCKERFILE

echo "aimux: building $IMAGE for $PLATFORM with Node $NODE_VERSION"
"$DOCKER" build \
  --platform "$PLATFORM" \
  --build-arg "NODE_VERSION=$NODE_VERSION" \
  --build-arg "RUNNER_UID=$RUNNER_UID" \
  --build-arg "RUNNER_GID=$RUNNER_GID" \
  -f "$DOCKERFILE" \
  -t "$IMAGE" \
  "$ROOT"

case "$MODE" in
  installed) REPRO_COMMAND='yarn installed:gate && yarn installed:local-gate' ;;
  native-test) REPRO_COMMAND='yarn native:test' ;;
  readiness) REPRO_COMMAND='yarn release:readiness' ;;
esac

echo "aimux: running $MODE lane in $PLATFORM Ubuntu container"
"$DOCKER" run --rm --init \
  --platform "$PLATFORM" \
  --name "aimux-linux-release-repro-$$" \
  --volume "$ROOT:/src:ro" \
  --env "REPRO_MODE=$MODE" \
  --env "REPRO_COMMAND=$REPRO_COMMAND" \
  --env "COREPACK_HOME=/tmp/aimux-corepack" \
  --env "YARN_CACHE_FOLDER=/tmp/aimux-yarn-cache" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    rm -rf "$RUNNER_TEMP"
    mkdir -p "$RUNNER_TEMP" /work
    echo "copying checkout into container workspace"
    rsync -a --delete \
      --exclude .aimux \
      --exclude .git \
      --exclude node_modules \
      --exclude app/node_modules \
      --exclude app/.expo \
      --exclude app/.vercel \
      --exclude app/dist \
      --exclude app/ios/Pods \
      --exclude app/ios/build \
      --exclude app/android/.gradle \
      --exclude app/android/app/build \
      --exclude relay/node_modules \
      --exclude native/target \
      --exclude release \
      --exclude dist-ui/assets/node_modules \
      /src/ "'"$CONTAINER_ROOT"'/"
    cd "'"$CONTAINER_ROOT"'"
    git init --quiet
    git config user.email "linux-release-repro@aimux.local"
    git config user.name "Aimux Linux Release Repro"
    git add -A
    git commit --quiet -m "linux release repro source snapshot"
    git config --global --add safe.directory "'"$CONTAINER_ROOT"'" || true
    echo "aimux linux release repro"
    echo "mode=$REPRO_MODE"
    echo "platform=$(uname -s)-$(uname -m)"
    echo "node=$(node --version)"
    echo "yarn=$(yarn --version)"
    echo "rust=$(rustc --version)"
    echo "tmux=$(tmux -V)"
    if env | grep "^AIMUX_" >/tmp/aimux-host-env.txt; then
      echo "aimux: unexpected inherited AIMUX_* env before CI setup:" >&2
      cat /tmp/aimux-host-env.txt >&2
      exit 1
    fi
    export AIMUX_HOME="$RUNNER_TEMP/aimux-home-release-readiness"
    export AIMUX_TMUX_SOCKET_PATH="$RUNNER_TEMP/aimux-release-readiness-tmux.sock"
    mkdir -p "$AIMUX_HOME"
    printf "{\"kind\":\"docker-linux-release-repro\",\"ownerPid\":%s}\n" "$$" > "$AIMUX_HOME/test-isolation.json"
    echo "installing dependencies"
    yarn install --frozen-lockfile
    yarn --cwd app install --frozen-lockfile
    echo "running: $REPRO_COMMAND"
    bash -lc "$REPRO_COMMAND"
  '
