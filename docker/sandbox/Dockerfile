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
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

WORKDIR /sandbox/package
USER sandbox

# The package directory is mounted at /sandbox/package by the orchestrator.
# stdout/stderr are streamed back to the host CLI.
# The container is destroyed (--rm) after the script completes.

# Entrypoint is provided at runtime by the orchestrator via --entrypoint.
# Example: docker run ... --entrypoint sh sandboxpm-sandbox -c "node install.js"
