# Sourced by the Homebrew release scripts. Homebrew names the formula that lacks
# a bottle -- `utf8proc: no bottle available!` -- and that is often a dependency
# rather than the formula the caller asked for. Retrying the caller's formula
# from source then cannot help: v0.1.61 failed the macOS tap gate twice on the
# same utf8proc line with every asset already published.
#
# Keep this in one place. The Linux gate installs the same formulae and had no
# retry at all, which is the second copy waiting to happen.

homebrew_log_reports_no_bottle() {
  local log_path="$1"
  grep -Eiq '(^|[^[:alpha:]])no bottle available([^[:alpha:]]|$)' "$log_path"
}

# Print the formula names the log says have no bottle, one per line.
homebrew_no_bottle_formulae() {
  local log_path="$1"
  grep -oiE '[A-Za-z0-9@_.+-]+: no bottle available' "$log_path" \
    | sed 's/:.*//' \
    | sort -u
}

# Build every formula the log names that is not `$target` from source. Returns 0
# when at least one was attempted, so the caller knows a retry is worth making.
homebrew_build_named_dependencies_from_source() {
  local log_path="$1"
  local target="$2"
  local context="$3"
  local platform_arch="$4"
  local short="${target##*/}"
  local named
  local attempted=1

  while IFS= read -r named; do
    [ -n "$named" ] || continue
    if [ "$named" = "$short" ] || [ "$named" = "$target" ]; then
      continue
    fi
    attempted=0
    printf 'Homebrew dependency %s of %s has no bottle available on %s; building it from source first\n' \
      "$named" "$context" "$platform_arch"
    set +e
    brew install --formula --build-from-source "$named" >>"$log_path" 2>&1
    local dep_status=$?
    set -e
    if [ "$dep_status" -ne 0 ]; then
      printf 'Homebrew could not build %s from source either (exit %s)\n' "$named" "$dep_status"
    fi
  done <<EOF
$(homebrew_no_bottle_formulae "$log_path")
EOF

  return "$attempted"
}
