# sandboxpm script sandbox
# Base image for running package install scripts in complete isolation.
# This container has NO access to the host filesystem, credentials, or env vars.

FROM node:20-alpine

# Run as non-root user (uid 1001)
RUN addgroup -g 1001 sandbox && \
    adduser -u 1001 -G sandbox -s /bin/sh -D sandbox

# Working directory for the package being sandboxed
RUN mkdir -p /sandbox/package && \
    chown -R sandbox:sandbox /sandbox

# Install only what npm install scripts typically need
# Do NOT install curl, wget, or any network tools
# strace is only invoked when sandbox.auditSyscalls is enabled (opt-in, requires
# CapAdd:['SYS_PTRACE'] + the seccomp-audit.json profile) — see SandboxRunner.
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    strace \
    && rm -rf /var/cache/apk/*

# Install common native-module build tools globally so install scripts can call
# them directly (node-pre-gyp, prebuild-install, cross-env, node-gyp).
# Pinned to avoid silent upgrades; update intentionally when needed.
RUN npm install -g \
    @mapbox/node-pre-gyp@1 \
    prebuild-install@7 \
    cross-env@7 \
    node-gyp@10 \
    node-addon-api@8 \
    nan@2 \
    && npm cache clean --force

# Pre-download Node.js headers for the current version so node-gyp can compile
# native modules without network access at install-script runtime.
# Store them in /usr/local/node-gyp-headers (world-readable, baked into image).
ENV npm_config_devdir=/usr/local/node-gyp-headers
RUN node-gyp install --ensure

COPY sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

WORKDIR /sandbox/package
USER sandbox
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]

# The package directory is mounted at /sandbox/package by the orchestrator.
# stdout/stderr are streamed back to the host CLI.
# The container is destroyed (--rm) after the script completes.

# Entrypoint is provided at runtime by the orchestrator via --entrypoint.
# Example: docker run ... --entrypoint sh sandboxpm-sandbox -c "node install.js"
