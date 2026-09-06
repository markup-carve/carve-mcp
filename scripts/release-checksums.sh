#!/usr/bin/env bash
set -euo pipefail

tag="${1:?Usage: scripts/release-checksums.sh RELEASE_TAG}"
asset_dir="$(mktemp -d)"
trap 'rm -rf "$asset_dir"' EXIT

gh release download "$tag" --pattern 'carve-mcp-rs-*' --dir "$asset_dir"
mapfile -t assets < <(find "$asset_dir" -maxdepth 1 -type f ! -name '*.sha256' -printf '%f\n' | sort)
legacy_assets=(
  carve-mcp-rs-aarch64-apple-darwin.tar.gz
  carve-mcp-rs-x86_64-apple-darwin.tar.gz
  carve-mcp-rs-x86_64-pc-windows-msvc.zip
  carve-mcp-rs-x86_64-unknown-linux-gnu.tar.gz
)
current_assets=(
  carve-mcp-rs-aarch64-apple-darwin.tar.gz
  carve-mcp-rs-aarch64-unknown-linux-gnu.tar.gz
  carve-mcp-rs-x86_64-apple-darwin.tar.gz
  carve-mcp-rs-x86_64-pc-windows-msvc.zip
  carve-mcp-rs-x86_64-unknown-linux-gnu.tar.gz
  carve-mcp-rs-x86_64-unknown-linux-musl.tar.gz
)
if [[ "${assets[*]}" != "${legacy_assets[*]}" && "${assets[*]}" != "${current_assets[*]}" ]]; then
  echo "Native release archives do not match the legacy or current artifact set:" >&2
  printf '  %s\n' "${assets[@]}" >&2
  exit 1
fi

(
  cd "$asset_dir"
  sha256sum "${assets[@]}" > SHA256SUMS
)
if [[ "${CHECKSUMS_DRY_RUN:-}" == "1" ]]; then
  cat "$asset_dir/SHA256SUMS"
else
  gh release upload "$tag" "$asset_dir/SHA256SUMS" --clobber
fi
