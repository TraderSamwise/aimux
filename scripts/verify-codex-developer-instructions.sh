#!/usr/bin/env bash
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is not installed or not on PATH" >&2
  exit 1
fi

instruction="aimux verification developer instructions $(date +%s)"
prompt="aimux verification user prompt"
config_value="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$instruction")"

output="$(codex debug prompt-input -c "developer_instructions=${config_value}" "$prompt")"

AIMUX_CODEX_PROMPT_INPUT="$output" node - "$instruction" "$prompt" <<'NODE'
const expectedInstruction = process.argv[2];
const expectedPrompt = process.argv[3];
const input = process.env.AIMUX_CODEX_PROMPT_INPUT ?? "";
const messages = JSON.parse(input);

function flattenText(message) {
  return (message.content ?? [])
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

const developer = messages.find((message) => message.role === "developer" && flattenText(message).includes(expectedInstruction));
const user = messages.find((message) => message.role === "user" && flattenText(message).includes(expectedPrompt));

if (!developer) {
  throw new Error("Codex did not expose developer_instructions as developer-visible prompt input");
}

if (!user) {
  throw new Error("Codex debug prompt-input did not include the verification user prompt");
}

console.log("Codex developer_instructions channel verified");
NODE
