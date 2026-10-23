#!/usr/bin/env bash
# Merges upstream's newest nightly tag into the fork's main and pushes it.
# Runs on pylon2 from the sync worktree; .github/fork/daily-sync.md drives it.
#
# Exit codes:
#   0  main already has the newest tag, or the clean merge was pushed
#   3  the merge conflicts; it is left in progress for resolution
#   4  a sync-conflict PR is still open, so nothing was merged
#   1  anything else
#
# Prints `previous=<tag>` and `latest=<tag>` so the caller can review the
# upstream range.

set -euo pipefail

FORK_REPO=tebiggs/t3code
TAG_FILE=.github/fork/upstream-tag

main() {
  cd "$(git rev-parse --show-toplevel)"
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "sync: the worktree has local changes; resolve or discard them first" >&2
    exit 1
  fi

  # A later merge on top of an unmerged resolution would conflict the same way.
  local open_pr
  open_pr="$(gh pr list --repo "$FORK_REPO" --state open --json number,headRefName \
    --jq '[.[] | select(.headRefName | startswith("sync-conflict/")) | .number] | first // empty')"
  if [[ -n "$open_pr" ]]; then
    echo "sync: waiting on sync-conflict PR #$open_pr"
    exit 4
  fi

  git fetch --quiet origin main
  local latest current
  latest="$(git ls-remote --tags --refs upstream 'refs/tags/v*-nightly.*' |
    sed 's#.*refs/tags/##' | sort -V | tail -n 1)"
  current="$(git show "origin/main:$TAG_FILE" | tr -d '[:space:]')"
  if [[ -z "$latest" || -z "$current" ]]; then
    echo "sync: could not read the upstream nightly tags or $TAG_FILE" >&2
    exit 1
  fi
  echo "previous=$current"
  echo "latest=$latest"
  if [[ "$latest" == "$current" ]]; then
    echo "sync: main already has $latest"
    exit 0
  fi

  git fetch --quiet --no-tags upstream \
    "refs/tags/$latest:refs/tags/$latest" "refs/tags/$current:refs/tags/$current"
  git checkout --quiet --detach origin/main

  # --no-ff even when main has no fork commits, so the tag file lands in a merge commit.
  if ! git merge --quiet --no-ff --no-commit "$latest"; then
    printf '%s\n' "$latest" > "$TAG_FILE"
    git add "$TAG_FILE"
    echo "sync: merging $latest conflicts in:"
    git diff --name-only --diff-filter=U
    exit 3
  fi

  printf '%s\n' "$latest" > "$TAG_FILE"
  git add "$TAG_FILE"
  git commit --quiet \
    -m "chore(fork): merge upstream $latest" \
    -m "Co-Authored-By: Claude <noreply@anthropic.com>"
  # Not forced: if main moved since the fetch, this fails and the next run retries.
  git push --quiet origin HEAD:refs/heads/main
  echo "sync: pushed $(git rev-parse --short=8 HEAD) to main"
}

# Wrapped in main so bash parses the whole file before the checkout above can replace it.
main "$@"
