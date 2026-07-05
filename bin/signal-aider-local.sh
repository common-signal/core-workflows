#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_SIGNAL_CONFIG="$ROOT_DIR/config/signal.example.yaml"
LOCAL_SIGNAL_CONFIG="$ROOT_DIR/config/signal.local.yaml"

if [[ -z "${SIGNAL_CONFIG:-}" && -f "$LOCAL_SIGNAL_CONFIG" ]]; then
  SIGNAL_CONFIG="$LOCAL_SIGNAL_CONFIG"
else
  SIGNAL_CONFIG="${SIGNAL_CONFIG:-$DEFAULT_SIGNAL_CONFIG}"
fi

if ! command -v aider >/dev/null 2>&1; then
  echo "Common Signal could not find 'aider' in PATH." >&2
  echo "Install Aider first, then rerun this script from the repository root." >&2
  exit 127
fi

if [[ ! -f "$SIGNAL_CONFIG" ]]; then
  echo "Common Signal config not found: $SIGNAL_CONFIG" >&2
  exit 1
fi

yaml_scalar() {
  local key="$1"
  awk -F': *' -v key="$key" '$1 ~ "^[[:space:]]*" key "$" { print $2; exit }' "$SIGNAL_CONFIG" |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

yaml_list_under() {
  local parent="$1"
  awk -v parent="$parent" '
    $0 ~ "^[[:space:]]*" parent ":" { in_parent = 1; next }
    in_parent && /^[^[:space:]]/ { exit }
    in_parent && /^[[:space:]]*-[[:space:]]/ {
      sub(/^[[:space:]]*-[[:space:]]*/, "", $0)
      gsub(/^"|"$/, "", $0)
      gsub(/^'\''|'\''$/, "", $0)
      print
    }
  ' "$SIGNAL_CONFIG"
}

CONFIG_OLLAMA_API_BASE="$(yaml_scalar api_base)"
CONFIG_AIDER_MODEL="$(yaml_scalar aider_model)"

export OLLAMA_API_BASE="${OLLAMA_API_BASE:-${CONFIG_OLLAMA_API_BASE:-http://127.0.0.1:11434}}"
export COMMON_SIGNAL_CONFIG="$SIGNAL_CONFIG"
export COMMON_SIGNAL_ARTIFACT_ROOT="${COMMON_SIGNAL_ARTIFACT_ROOT:-$(yaml_scalar artifact_root)}"
export COMMON_SIGNAL_RUNTIME_ROOT="${COMMON_SIGNAL_RUNTIME_ROOT:-$(yaml_scalar runtime_root)}"
export COMMON_SIGNAL_PRIVACY_POLICY="${COMMON_SIGNAL_PRIVACY_POLICY:-$(yaml_scalar default_policy)}"
export COMMON_SIGNAL_ATTACHMENT_MODE="${COMMON_SIGNAL_ATTACHMENT_MODE:-$(yaml_scalar manifest_only)}"
export COMMON_SIGNAL_MODEL="${COMMON_SIGNAL_MODEL:-${AIDER_OLLAMA_MODEL:-${CONFIG_AIDER_MODEL:-ollama_chat/qwen2.5-coder}}}"

COMMON_SIGNAL_ARTIFACT_ROOT="${COMMON_SIGNAL_ARTIFACT_ROOT:-.common-signal}"
COMMON_SIGNAL_RUNTIME_ROOT="${COMMON_SIGNAL_RUNTIME_ROOT:-.common-signal/runtime}"
COMMON_SIGNAL_PRIVACY_POLICY="${COMMON_SIGNAL_PRIVACY_POLICY:-pii-scrub-required}"
COMMON_SIGNAL_ATTACHMENT_MODE="${COMMON_SIGNAL_ATTACHMENT_MODE:-true}"

mkdir -p "$ROOT_DIR/$COMMON_SIGNAL_RUNTIME_ROOT"

BOUNDARY_FILE="$ROOT_DIR/$COMMON_SIGNAL_RUNTIME_ROOT/aider-local-boundaries.env"
{
  printf 'OLLAMA_API_BASE=%s\n' "$OLLAMA_API_BASE"
  printf 'COMMON_SIGNAL_CONFIG=%s\n' "$COMMON_SIGNAL_CONFIG"
  printf 'COMMON_SIGNAL_ARTIFACT_ROOT=%s\n' "$COMMON_SIGNAL_ARTIFACT_ROOT"
  printf 'COMMON_SIGNAL_RUNTIME_ROOT=%s\n' "$COMMON_SIGNAL_RUNTIME_ROOT"
  printf 'COMMON_SIGNAL_PRIVACY_POLICY=%s\n' "$COMMON_SIGNAL_PRIVACY_POLICY"
  printf 'COMMON_SIGNAL_ATTACHMENT_MODE=%s\n' "$COMMON_SIGNAL_ATTACHMENT_MODE"
  printf 'COMMON_SIGNAL_DENY_GLOBS='
  yaml_list_under deny_globs | paste -sd ',' -
  printf '\n'
} > "$BOUNDARY_FILE"

echo "Common Signal local Aider launcher"
echo "Config: $SIGNAL_CONFIG"
echo "Ollama: $OLLAMA_API_BASE"
echo "Model: $COMMON_SIGNAL_MODEL"
echo "Privacy policy: $COMMON_SIGNAL_PRIVACY_POLICY"
echo "Runtime boundary file: $BOUNDARY_FILE"
echo

cd "$ROOT_DIR"
exec aider --model "$COMMON_SIGNAL_MODEL" --architect --auto-commits "$@"
