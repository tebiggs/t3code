# Daily fork sync

A T3 scheduled task follows these steps once a day. Its prompt names the sync
worktree: a detached worktree of the fork, with an `upstream` remote for
`pingdotgg/t3code`, used only for this sync. Work only there, and never touch
other checkouts or worktrees.

Hard rules:

- Never push to `upstream`, and never open or comment on anything in
  `pingdotgg/t3code`. PRs go to the fork: `gh pr create --repo tebiggs/t3code --base main`.
- Never force-push, never merge a PR, and never push to `main` except through
  `sync.sh`.
- Follow the host's own instructions for installs, typechecks and tests, and
  run only the targeted ones you need. CI on the PR runs the rest.
- After opening a PR, register it with `link_pull_request`.

## 1. Merge upstream

From the sync worktree:

```sh
git fetch --quiet origin main && git checkout --quiet --detach origin/main
.github/fork/sync.sh
```

Note the `previous=` and `latest=` lines it prints.

- **Exit 0:** main is current. Go to step 2.
- **Exit 4:** a sync-conflict PR is still open. Report it and go to step 2.
- **Exit 3:** the merge conflicts. Resolve it:
  - Take upstream's side unless the conflict touches a feature listed in
    `FORK.md`. Then keep the fork behavior working on top of upstream's new code.
  - Don't make unrelated changes.
  - Commit as `chore(fork): merge upstream <latest>` with the
    `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.
  - Push the commit to `sync-conflict/<latest>` and open a PR with the same title.
  - Start the body with "Merge this with **Create a merge commit**, not squash, so
    upstream history stays intact." Then list each conflicted file and how you
    resolved it.
- **Any other exit:** report the output. Then run `git merge --abort` if a merge
  is in progress, and `git checkout --quiet --detach origin/main`.

## 2. Check the last release build

```sh
gh run list --repo tebiggs/t3code --workflow fork-release.yml --branch main \
  --event push --status completed --limit 1 \
  --json databaseId,attempt,conclusion,headSha,url
```

If that run failed, read `gh run view <id> --repo tebiggs/t3code --log-failed`.

- If the failure looks like runner or network trouble, rerun the whole run with
  `gh run rerun <id> --repo tebiggs/t3code`, but only when `attempt` is 1 and
  `headSha` is still `origin/main`. A newer build replaces an older one.
  Don't use `--failed`: build artifacts expire after a day, so the retried jobs
  couldn't download what the passing jobs built. If the token lacks permission
  to rerun, report the failure instead.
- If the code broke, fix it on a `fix/fork-<topic>` branch from `origin/main`
  and open a PR. Skip this if an open PR already fixes it.

## 3. Look for upstream features that replace fork features

Skip this step when `previous` equals `latest`. Otherwise list what upstream
merged in that range:

```sh
git log --first-parent --format='%s' <previous>..<latest>
```

Compare those titles with the features in `FORK.md`. Read an upstream PR's diff
when its title alone doesn't tell you. A title ending in `(#N)` links to
`https://github.com/pingdotgg/t3code/pull/N`.

When upstream now covers what a fork feature does for the user, even if it
works differently, open a PR on `dedup/<feature-slug>`. The PR should:

- remove the fork version
- keep anything upstream doesn't cover
- update `FORK.md`
- link the upstream PRs

Skip the PR if one is already open for that feature. If the overlap is only
partial, don't open a PR; mention it in the report instead.

## 4. Report

Write a few sentences:

- what merged, or that main was already current
- every PR you opened, with its link
- any failed build and what you did about it
- any partial overlaps

Leave out steps that found nothing.
