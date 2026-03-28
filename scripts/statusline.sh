#!/usr/bin/env bash
# aimux statusline for Claude Code
# Wraps the user's existing statusline and appends aimux agent info.
# Reads Claude Code JSON from stdin, finds the matching aimux project,
# and renders agent indicators + task counts.

set -euo pipefail

input=$(cat)

# ── Original statusline (user's existing content) ──────────────────

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
session_name=$(echo "$input" | jq -r '.session_name // empty')

RESET=$'\033[0m'
BOLD=$'\033[1m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
MAGENTA=$'\033[35m'
BLUE=$'\033[34m'
RED=$'\033[31m'
DIM=$'\033[2m'

# Shorten home directory
if [ -n "$cwd" ]; then
  home="$HOME"
  short_cwd="${cwd/#$home/~}"
else
  short_cwd="~"
fi

# Git branch
git_branch=""
if [ -n "$cwd" ] && git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  if [ -n "$branch" ]; then
    git_branch=" ${DIM}${GREEN}${branch}${RESET}"
  fi
fi

# Context usage bar
ctx_str=""
if [ -n "$used_pct" ]; then
  pct_int=${used_pct%.*}
  if [ "$pct_int" -ge 80 ] 2>/dev/null; then
    ctx_color=$RED
  elif [ "$pct_int" -ge 50 ] 2>/dev/null; then
    ctx_color=$YELLOW
  else
    ctx_color=$GREEN
  fi
  bar_width=10
  filled=$(( pct_int * bar_width / 100 ))
  empty=$(( bar_width - filled ))
  bar=""
  for i in $(seq 1 $filled); do bar="${bar}█"; done
  for i in $(seq 1 $empty); do bar="${bar}░"; done
  ctx_str=" ${ctx_color}${bar}${RESET}${DIM}${pct_int}%${RESET}"
fi

# Model
model_str=""
if [ -n "$model" ]; then
  model_str=" ${DIM}${MAGENTA}${model}${RESET}"
fi

# Session name
session_str=""
if [ -n "$session_name" ]; then
  session_str=" ${DIM}[${session_name}]${RESET}"
fi

user=$(whoami)
host=$(hostname -s)

base_line="${CYAN}${user}@${host}${RESET} ${BLUE}${short_cwd}${RESET}${git_branch}${ctx_str}${model_str}${session_str}"

# ── Aimux agent info ───────────────────────────────────────────────

aimux_str=""
AIMUX_DIR="$HOME/.aimux"
REGISTRY="$AIMUX_DIR/projects.json"

if [ -f "$REGISTRY" ] && [ -n "$cwd" ]; then
  # Find the project matching this cwd by checking repoRoot prefixes
  project_id=""
  while IFS= read -r line; do
    repo_root=$(echo "$line" | jq -r '.repoRoot // empty')
    pid=$(echo "$line" | jq -r '.id // empty')
    if [ -n "$repo_root" ] && [[ "$cwd" == "$repo_root"* ]]; then
      project_id="$pid"
      break
    fi
  done < <(jq -c '.projects[]' "$REGISTRY" 2>/dev/null)

  if [ -n "$project_id" ]; then
    SL_FILE="$AIMUX_DIR/projects/$project_id/statusline.json"
    if [ -f "$SL_FILE" ]; then
      # Check staleness (>10s = aimux not running)
      if [ "$(uname)" = "Darwin" ]; then
        file_age=$(( $(date +%s) - $(stat -f %m "$SL_FILE") ))
      else
        file_age=$(( $(date +%s) - $(stat -c %Y "$SL_FILE") ))
      fi

      if [ "$file_age" -le 10 ]; then
        # Build agent indicators
        agents=""
        while IFS= read -r sess; do
          tool=$(echo "$sess" | jq -r '.tool')
          status=$(echo "$sess" | jq -r '.status')
          role=$(echo "$sess" | jq -r '.role // empty')
          active=$(echo "$sess" | jq -r '.active')

          # Status icon with color
          case "$status" in
            idle)    icon="${GREEN}●${RESET}" ;;
            running) icon="${YELLOW}●${RESET}" ;;
            waiting) icon="${CYAN}◉${RESET}" ;;
            *)       icon="${RED}○${RESET}" ;;
          esac

          # Role tag
          role_tag=""
          if [ -n "$role" ]; then
            role_tag="${DIM}(${role})${RESET}"
          fi

          # Bold if active
          if [ "$active" = "true" ]; then
            agents="${agents} ${BOLD}${icon}${tool}${role_tag}${RESET}"
          else
            agents="${agents} ${icon}${DIM}${tool}${role_tag}${RESET}"
          fi
        done < <(jq -c '.sessions[]' "$SL_FILE" 2>/dev/null)

        # Task counts
        task_str=""
        pending=$(jq -r '.tasks.pending // 0' "$SL_FILE" 2>/dev/null)
        assigned=$(jq -r '.tasks.assigned // 0' "$SL_FILE" 2>/dev/null)
        if [ "$pending" -gt 0 ] || [ "$assigned" -gt 0 ]; then
          task_str=" ${DIM}[T:${pending}p/${assigned}a]${RESET}"
        fi

        # Flash message
        flash_str=""
        flash=$(jq -r '.flash // empty' "$SL_FILE" 2>/dev/null)
        if [ -n "$flash" ]; then
          flash_str=" ${MAGENTA}${flash}${RESET}"
        fi

        if [ -n "$agents" ]; then
          aimux_str="  ${DIM}│${RESET}${agents}${task_str}${flash_str}"
        fi
      fi
    fi
  fi
fi

printf '%s' "${base_line}${aimux_str}"
