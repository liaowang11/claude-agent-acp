#!/usr/bin/env bash
#
# Sync nix/package.nix's npmDepsHash with package-lock.json.
#
# The Nix build pins the npm dependencies as a fixed-output derivation keyed on
# the whole lockfile, so any change to package-lock.json invalidates the hash --
# including an upstream release that only bumps the "version" field. When they
# disagree, npmConfigHook aborts the build with "npmDepsHash is out of date",
# which has broken the Build workflow on every upstream release so far.
#
# Run this after rebasing the fork onto a new upstream release, before pushing.
#
# Requires nix with flakes enabled. Nothing else: the hash comes from
# nixpkgs#prefetch-npm-deps, so no npm install happens here.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/sync-nix-npm-deps.sh [--no-build] [--help]

Rewrites npmDepsHash in nix/package.nix to match package-lock.json, then builds
the flake package to prove the result is what CI will build.

  --no-build  Update the hash but skip the build. Faster, and useful when you
              are about to build for another system anyway.
  --help      Show this message.

Exits non-zero if the build fails; the hash is still written, so re-running with
--no-build will report the file as already up to date.
EOF
}

build=true
while [ $# -gt 0 ]; do
  case $1 in
  --no-build) build=false ;;
  --help | -h)
    usage
    exit 0
    ;;
  *)
    printf 'FAIL  unknown argument: %s\n\n' "$1" >&2
    usage >&2
    exit 2
    ;;
  esac
  shift
done

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok    %s\n' "$1"
}

command -v nix >/dev/null 2>&1 ||
  fail "nix is not installed."

root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  fail "not inside a git checkout."
cd "$root"

package_nix="nix/package.nix"
lockfile="package-lock.json"
[ -f "$package_nix" ] || fail "$package_nix does not exist."
[ -f "$lockfile" ] || fail "$lockfile does not exist."

# nix/package.nix reads the version straight from package.json, so the only
# thing left to sync is the hash. Report the version anyway: it names the
# release this lockfile belongs to, which is what makes the commit message.
version=$(node -p 'require("./package.json").version' 2>/dev/null) ||
  fail "cannot read the version from package.json."

current=$(awk -F'"' '/^ *npmDepsHash *=/ { print $2; exit }' "$package_nix")
[ -n "$current" ] ||
  fail "no npmDepsHash assignment found in $package_nix."

# prefetch-npm-deps downloads every tarball in the lockfile to hash them, and
# this one pulls the ~200 MB prebuilt claude CLI. It prints nothing while it
# does, so say so rather than looking hung for several minutes.
printf '      hashing %s, this takes a few minutes...\n' "$lockfile"
wanted=$(nix run nixpkgs#prefetch-npm-deps -- "$lockfile") ||
  fail "prefetch-npm-deps failed to hash $lockfile."

if [ "$current" = "$wanted" ]; then
  pass "npmDepsHash already matches $lockfile ($version)"
else
  # awk rather than sed -i: the hash is base64 and BSD and GNU sed disagree
  # about -i, so this stays portable and needs no escaping.
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  awk -v hash="$wanted" '
    !done && /^ *npmDepsHash *=/ {
      sub(/"[^"]*"/, "\"" hash "\"")
      done = 1
    }
    { print }
  ' "$package_nix" >"$tmp"
  cat "$tmp" >"$package_nix"

  printf 'ok    npmDepsHash updated for %s\n        was %s\n        now %s\n' \
    "$version" "$current" "$wanted"
fi

if [ "$build" = false ]; then
  printf '\nSkipped the build. Verify with:\n\n  nix build --print-build-logs .#default\n'
  exit 0
fi

log=$(mktemp)
printf '      building .#default, this takes a few minutes...\n'
if ! nix build --no-link --print-build-logs .#default >"$log" 2>&1; then
  printf 'FAIL  nix build .#default failed. Last 20 lines:\n\n' >&2
  tail -20 "$log" >&2
  printf '\n      Full log: %s\n' "$log" >&2
  exit 1
fi
rm -f "$log"
pass "nix build .#default succeeds"

cat <<EOF

nix/package.nix is in sync with $lockfile ($version).

  git commit -m "nix: Sync npm deps hash to $version" $package_nix

The other systems in the Build matrix are only checked by CI.
EOF
