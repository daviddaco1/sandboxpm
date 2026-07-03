#!/bin/sh
# Seed the writable node_modules tmpfs with native build helpers that
# node-gyp needs to find as resolvable modules (not just PATH tools).
# node-addon-api and nan declare gyp targets; gyp writes .target.mk files
# back into the package directory, which requires it to be writable.
for pkg in node-addon-api nan; do
  src="/usr/local/lib/node_modules/$pkg"
  if [ -d "$src" ]; then
    cp -r "$src" /sandbox/package/node_modules/ 2>/dev/null || true
  fi
done

# Wire up the dependency tree: each line is "LINK_PATH<TAB>TARGET_PATH".
# /sandbox/deps and every /sandbox/scopes/{n} dir are writable tmpfs, so
# creating these symlinks (and their parent dirs, for scoped @org/pkg names)
# never touches the read-only bind mounts holding the actual package files.
if [ -n "$SANDBOXPM_LINKS" ]; then
  printf '%s\n' "$SANDBOXPM_LINKS" | while IFS="$(printf '\t')" read -r link target; do
    [ -z "$link" ] && continue
    mkdir -p "$(dirname "$link")"
    ln -sfn "$target" "$link"
  done
fi

exec "$@"
