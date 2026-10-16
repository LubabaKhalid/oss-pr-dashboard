#!/usr/bin/env bash
# Refreshes data/snapshot.json with the current state of all PRs.
# Needs the GitHub CLI (gh) logged in, or GH_TOKEN set (as in GitHub Actions).
set -euo pipefail
cd "$(dirname "$0")/.."
USER_NAME=$(jq -r .username data/config.json)
mapfile -t EXCLUDE < <(jq -r '.exclude[]' data/config.json)

gh api -X GET search/issues --paginate -f q="author:${USER_NAME} type:pr" -f per_page=100 \
  --jq '.items[] | {repo: (.repository_url | sub(".*/repos/";"")), number, title, url: .html_url,
        state: (if .pull_request.merged_at != null then "merged" elif .state == "open" then "open" else "closed" end),
        created: .created_at, closed: .closed_at, draft}' \
| jq -s --argjson ex "$(printf '%s\n' "${EXCLUDE[@]}" | jq -R . | jq -s .)" '
    def excluded($repo): [ $ex[] | . as $p | if endswith("/*") then ($repo | ascii_downcase | startswith($p[:-1] | ascii_downcase)) else ((. | ascii_downcase) == ($repo | ascii_downcase)) end ] | any;
    {fetchedAt: (now | todate), prs: [ .[] | select(excluded(.repo) | not) ] | sort_by(.repo, -.number)}' \
> data/snapshot.json

echo "Wrote $(jq '.prs | length' data/snapshot.json) PRs to data/snapshot.json"
