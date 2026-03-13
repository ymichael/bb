#!/usr/bin/env sh
set -u

log() {
  printf '%s\n' "[bb-env-setup] $*"
}

run_step() {
  step_name="$1"
  shift
  log "Running: ${step_name}"
  if "$@"; then
    log "Completed: ${step_name}"
    return 0
  else
    exit_code=$?
    log "Warning: ${step_name} failed (exit ${exit_code}); continuing provisioning"
    return 0
  fi
}

if ! command -v pnpm >/dev/null 2>&1; then
  log "Warning: pnpm is not available; skipping install/build"
  exit 0
fi

if [ ! -f package.json ]; then
  log "Warning: package.json not found; skipping install/build"
  exit 0
fi

run_step "pnpm install" pnpm install
