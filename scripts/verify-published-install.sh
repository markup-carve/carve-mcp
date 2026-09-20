#!/usr/bin/env bash
# Run a just-published npm version from a clean directory.
#
# npm answers ETARGET for a version it has accepted but not yet propagated, and
# says so itself: "Your package is being processed and may take a few minutes to
# become available." So a not-yet-served answer is retried across a propagation
# budget, while any other failure fails at once: that one means the package
# resolved and the server is broken.
set -euo pipefail

package="${1:?Usage: scripts/verify-published-install.sh PACKAGE VERSION [BIN]}"
version="${2:?Usage: scripts/verify-published-install.sh PACKAGE VERSION [BIN]}"
bin="${3:-carve-mcp}"
spec="$package@${version#v}"

budget_seconds="${VERIFY_INSTALL_BUDGET_SECONDS:-600}"
first_delay="${VERIFY_INSTALL_FIRST_DELAY_SECONDS:-10}"
max_delay="${VERIFY_INSTALL_MAX_DELAY_SECONDS:-60}"
attempt_timeout="${VERIFY_INSTALL_ATTEMPT_TIMEOUT_SECONDS:-120}"

# npx must not resolve the bin against this package's own checkout: that checkout
# IS this package but does not depend on itself, so the bin is not found.
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
cd "$work_dir"

# Without this, a packument cached on the first attempt can outlive the whole
# retry loop and hide the version that arrived in the meantime.
export npm_config_prefer_online=true

not_served='ETARGET|E404|No matching version found|404 Not Found'
started=$SECONDS
deadline=$((SECONDS + budget_seconds))
delay="$first_delay"
attempt=0
output=

while true; do
  attempt=$((attempt + 1))
  set +e
  output="$(timeout "$attempt_timeout" npx --yes --package "$spec" "$bin" </dev/null 2>&1)"
  status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    echo "$spec installs and runs (attempt $attempt, $((SECONDS - started))s after the first probe)."
    exit 0
  fi

  if ! grep -Eq "$not_served" <<<"$output"; then
    echo "$output" >&2
    # Annotations are only parsed off stdout, so the headline goes there.
    echo "::error::$spec failed with exit $status and npm did not report a missing version, so this is not a propagation delay. Read the output above."
    exit 1
  fi

  remaining=$((deadline - SECONDS))
  if [[ $remaining -le 0 ]]; then
    break
  fi
  if [[ $delay -gt $remaining ]]; then
    delay=$remaining
  fi
  echo "npm does not serve $spec yet (attempt $attempt); retrying in ${delay}s, ${remaining}s of budget left."
  sleep "$delay"
  delay=$((delay * 2))
  if [[ $delay -gt $max_delay ]]; then
    delay=$max_delay
  fi
done

echo "$output" >&2
echo "::error::npm still does not serve $spec after $attempt attempts over $((SECONDS - started))s."
echo "The publish itself may well have succeeded. A new version becomes resolvable on the"
echo "registry's own schedule, and npm publish says so: your package is being processed and"
echo "may take a few minutes to become available. This org has measured gaps of two to three"
echo "minutes. Run: npm view $spec version"
echo "If that prints the version, the release is fine and only this check timed out."
exit 1
