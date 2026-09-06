#!/usr/bin/env bash
set -euo pipefail

version=1.8.1
base="https://github.com/modelcontextprotocol/registry/releases/download/v$version"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

curl --fail --location --silent --show-error --output "$work_dir/publisher.tar.gz" \
  "$base/mcp-publisher_linux_amd64.tar.gz"
curl --fail --location --silent --show-error --output "$work_dir/checksums.txt" \
  "$base/registry_${version}_checksums.txt"
grep ' mcp-publisher_linux_amd64.tar.gz$' "$work_dir/checksums.txt" \
  | sed "s#mcp-publisher_linux_amd64.tar.gz#$work_dir/publisher.tar.gz#" \
  | sha256sum --check --strict
tar xzf "$work_dir/publisher.tar.gz" -C "$work_dir" mcp-publisher
if [[ "${PUBLISH_REGISTRY_DRY_RUN:-}" == "1" ]]; then
  "$work_dir/mcp-publisher" --version
  exit 0
fi
"$work_dir/mcp-publisher" login github-oidc
for attempt in 1 2 3 4 5; do
  if "$work_dir/mcp-publisher" publish server.json; then
    exit 0
  fi
  sleep $((attempt * 10))
done
exit 1
