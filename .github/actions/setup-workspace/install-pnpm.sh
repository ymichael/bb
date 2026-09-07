#!/usr/bin/env bash
# Installs the pinned pnpm release binary straight from GitHub Releases.
#
# pnpm/action-setup bootstraps pnpm with `npm ci` against the npm registry and
# then runs `pnpm self-update`, so every job paid two registry round trips
# before doing any work: 30 s on a good day, and 7 minutes on the runs where
# the registry stalled (the same stall hit every job of the run at once). A
# GitHub release asset is a single download from the CDN the runner already
# talks to for checkout, and the pinned sha256 gives the same integrity the
# action's committed lockfile did.
set -euo pipefail

version="${PNPM_VERSION:?PNPM_VERSION is required}"
action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checksums="${action_dir}/pnpm-${version}.sha256"
package_manager="$(node --print 'require(process.argv[1]).packageManager' "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}/package.json")"

if [[ "${package_manager}" != "pnpm@${version}" ]]; then
  echo "::error::pnpm version mismatch: package.json declares ${package_manager#pnpm@}, but the action requested ${version}."
  exit 1
fi

if [[ ! -f "${checksums}" ]]; then
  echo "::error::No checksums for pnpm ${version}. Download the release assets from https://github.com/pnpm/pnpm/releases/tag/v${version}, run sha256sum on them, and commit the output as ${checksums}."
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset="pnpm-linux-x64" ;;
  Linux-aarch64 | Linux-arm64) asset="pnpm-linux-arm64" ;;
  Darwin-arm64) asset="pnpm-macos-arm64" ;;
  Darwin-x86_64) asset="pnpm-macos-x64" ;;
  *)
    echo "::error::Unsupported runner platform $(uname -s)-$(uname -m) for the pnpm release binary."
    exit 1
    ;;
esac

expected="$(awk -v asset="${asset}" '$2 == asset { print $1 }' "${checksums}")"
if [[ -z "${expected}" ]]; then
  echo "::error::${checksums} has no entry for ${asset}."
  exit 1
fi

install_dir="${RUNNER_TEMP:-/tmp}/pnpm-${version}"
mkdir -p "${install_dir}/bin"
binary="${install_dir}/bin/pnpm"

url="https://github.com/pnpm/pnpm/releases/download/v${version}/${asset}"
curl --fail --silent --show-error --location \
  --retry 5 --retry-all-errors --retry-delay 2 \
  --connect-timeout 15 --max-time 180 \
  --output "${binary}" "${url}"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${binary}" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "${binary}" | awk '{ print $1 }')"
fi
if [[ "${actual}" != "${expected}" ]]; then
  echo "::error::sha256 mismatch for ${asset}: expected ${expected}, got ${actual}."
  exit 1
fi

chmod +x "${binary}"
ln -sf pnpm "${install_dir}/bin/pnpx"
echo "${install_dir}/bin" >> "${GITHUB_PATH}"
echo "PNPM_HOME=${install_dir}/bin" >> "${GITHUB_ENV}"
echo "Installed pnpm $("${binary}" --version) from ${url}"
