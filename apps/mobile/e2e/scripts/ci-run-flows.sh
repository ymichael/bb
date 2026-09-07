#!/usr/bin/env bash
# Runs the Maestro flows CI can run against a Release build of the app (the
# embedded JS bundle, no Metro) and a fresh mobile e2e backend, one `maestro
# test` per flow so each gets its own artifacts, continuing past failures and
# exiting non-zero if any flow failed.
#
# Usage:
#   SERVER_URL=http://127.0.0.1:41999 \
#   e2e/scripts/ci-run-flows.sh <simulator udid> <artifacts dir> [flow...]
#
# Default flows (in this order): shell-launch, shell-deep-link, shell-send,
# shell-unreachable-server. Every one drives the WebView shell, so the backend
# must be started with BB_MOBILE_E2E_SERVE_APP=1 and apps/app must be built
# (`pnpm exec turbo run build --filter=@bb/app`); without them the server
# answers API routes only and the shell shows its native error state.
#
# shell-connect is not in the default set: it needs the connect stub backend
# (`pnpm --filter @bb/integration-tests e2e:mobile-connect-stub`), so it runs
# on its own.
#
# Environment: SERVER_URL (default http://127.0.0.1:41999; the flows' own
# env blocks point at the same port), MAESTRO_FLAGS (extra `maestro test`
# flags). Needs maestro + java on PATH. Every flow gets
# `-e BB_E2E_EMBEDDED_BUNDLE=1` (see ../subflows/launch-app.yaml); pass
# `--dev-client` as the first argument to drive a dev client through Metro
# instead (local use).
# (bash 3.2 on macOS: empty arrays are expanded with the `${arr[@]+"${arr[@]}"}`
# idiom so `set -u` does not trip.)
set -uo pipefail

cd "$(dirname "$0")/.."

LAUNCH_ENV=(-e BB_E2E_EMBEDDED_BUNDLE=1)
if [ "${1:-}" = "--dev-client" ]; then
  LAUNCH_ENV=()
  shift
fi

UDID="${1:?simulator udid}"
ARTIFACTS="${2:?artifacts dir}"
shift 2
FLOWS=("$@")
if [ ${#FLOWS[@]} -eq 0 ]; then
  FLOWS=(shell-launch shell-deep-link shell-send shell-unreachable-server)
fi

export SERVER_URL="${SERVER_URL:-http://127.0.0.1:41999}"
mkdir -p "$ARTIFACTS"

failed=()
for flow in "${FLOWS[@]}"; do
  file="flows/$flow.yaml"
  out="$ARTIFACTS/$flow"
  mkdir -p "$out"
  echo "::group::maestro $flow"
  # shellcheck disable=SC2086
  if maestro --device "$UDID" test \
      ${LAUNCH_ENV[@]+"${LAUNCH_ENV[@]}"} \
      --format junit --output "$out/junit.xml" \
      --test-output-dir "$out" \
      ${MAESTRO_FLAGS:-} \
      "$file" 2>&1 | tee "$out/maestro.log"; then
    echo "PASS $flow"
  else
    echo "FAIL $flow"
    failed+=("$flow")
    # A failed flow can leave the app on any screen; the next flow cold-starts
    # it, but keep a screenshot of where this one ended.
    xcrun simctl io "$UDID" screenshot "$out/final-screen.png" >/dev/null 2>&1 || true
    cleanup="$out/cleanup"
    mkdir -p "$cleanup"
    if maestro --device "$UDID" test \
        ${LAUNCH_ENV[@]+"${LAUNCH_ENV[@]}"} \
        --format junit --output "$cleanup/junit.xml" \
        --test-output-dir "$cleanup" \
        ${MAESTRO_FLAGS:-} \
        "subflows/clear-open-confirmation.yaml" 2>&1 | tee "$cleanup/maestro.log"; then
      echo "RESET after $flow"
    else
      echo "Failed to clear native state after $flow; stopping before the next flow" >&2
      echo "::endgroup::"
      break
    fi
  fi
  echo "::endgroup::"
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed flows: ${failed[*]}" >&2
  exit 1
fi
echo "All ${#FLOWS[@]} flows passed"
