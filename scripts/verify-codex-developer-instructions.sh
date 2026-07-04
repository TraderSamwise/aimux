#!/usr/bin/env bash
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is not installed or not on PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not installed or not on PATH" >&2
  exit 1
fi

instruction="aimux verification developer instructions $(date +%s)"
prompt="aimux verification user prompt"
config_value="$(jq -Rn --arg value "$instruction" '$value')"

output="$(codex debug prompt-input -c "developer_instructions=${config_value}" "$prompt")"

flatten_text='(.content // []) | map(select(.text? | type == "string") | .text) | join("\n")'

if ! printf '%s' "$output" | jq -e --arg expected "$instruction" "any(.[]; .role == \"developer\" and (($flatten_text) | contains(\$expected)))" >/dev/null; then
  echo "Codex did not expose developer_instructions as developer-visible prompt input" >&2
  exit 1
fi

if ! printf '%s' "$output" | jq -e --arg expected "$prompt" "any(.[]; .role == \"user\" and (($flatten_text) | contains(\$expected)))" >/dev/null; then
  echo "Codex debug prompt-input did not include the verification user prompt" >&2
  exit 1
fi

echo "Codex developer_instructions channel verified"
