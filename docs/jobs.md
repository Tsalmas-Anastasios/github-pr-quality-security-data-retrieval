# Job inputs

Run `npm run job -- <name> --input '<json>'`, or use `--config path/to/input.json`. Every job accepts `--format csv|json|jsonl`, `--output path`, and `--overwrite`. Job inputs are validated; misspelled or unsupported options fail instead of being ignored.

## GitHub pull requests

Name: `github:pull-requests`.

| Input            | Type                       | Default  | Meaning                                      |
| ---------------- | -------------------------- | -------- | -------------------------------------------- |
| `repository`     | String                     | Required | Repository in `owner/repo` format            |
| `state`          | `open`, `closed`, `all`    | `all`    | GitHub PR state filter                       |
| `perPage`        | Integer 1–100              | `100`    | Records per API page                         |
| `maxItems`       | Positive integer or `null` | `100`    | Maximum emitted records; `null` collects all |
| `includeDetails` | Boolean                    | `false`  | Fetch each PR separately for detailed counts |
| `labels`         | Array of strings           | `[]`     | Require every specified label, ignoring case |
| `createdAfter`   | ISO timestamp              | Unset    | Inclusive lower creation-date boundary       |
| `createdBefore`  | ISO timestamp              | Unset    | Inclusive upper creation-date boundary       |

Example for a complete date window:

```json
{
    "repository": "microsoft/TypeScript",
    "state": "closed",
    "createdAfter": "2025-01-01T00:00:00Z",
    "createdBefore": "2025-12-31T23:59:59Z",
    "maxItems": null,
    "includeDetails": true
}
```

The job requests `/repos/{owner}/{repo}/pulls`, sorted by creation date descending, and follows `Link` headers. Date and label filtering happen locally. `maxItems` counts records that pass those filters. With `includeDetails: true`, it also requests `/repos/{owner}/{repo}/pulls/{number}` for each selected record. This increases API usage substantially.

The output contains repository, PR ID and number, title and body, state, draft status, author, URL, timestamps, merge status, branch names and SHAs, labels, and time to merge in hours. Detailed columns are `additions`, `deletions`, `changed_files`, `commits`, `comments`, and `review_comments`. Missing counts are `null`, which CSV writes as empty cells. A deleted author is also `null`. These jobs collect source data; quality or security classification belongs in your own processing step.

PR data can change while collection runs; results reflect the responses received during that run. The REST API does not provide an immutable repository snapshot for this job.

## Repository discovery

Name: `github:repositories`. Input:

```json
{
    "owners": ["octocat"],
    "ownerType": "user",
    "perPage": 100,
    "maxItems": 100
}
```

`owners` is a non-empty list of user or organization names. `ownerType` is `user` (default) or `organization`. User discovery collects public repositories owned by that user; organization discovery collects repositories visible to the configured token, or public repositories without a token. The job follows pagination, skips duplicate owners and repository names, and applies `maxItems` across the entire run.

Output includes owner, name, full name, browser URL, description, language, default branch, visibility and archive flags, stars, forks, issue count, and timestamps. You can use `full_name` values as inputs to the PR job.

Each unique repository prints a JSON progress message through `console.log` after its metadata is fetched, including a timestamp, full repository name, and completed count.

```sh
npm run job -- github:repositories --config examples/github-repositories.json --format csv
```

## Repositories with total pull request counts

Name: `github:repositories-pr-counts`. Input:

```json
{
    "owners": ["apache", "microsoft", "facebook"]
}
```

`owners` accepts any number of user and organization names, including an empty list. Owner types are detected automatically. This job collects all available pages with 100 repositories per page and does not accept `maxItems`, `perPage`, or `ownerType`. Owners are deduplicated case-insensitively and repositories by GitHub ID. It includes accessible private repositories owned by the authenticated account and visible organization repositories.

The output columns are `repository_name`, `username`, `full_name`, `total_pull_requests`, `visibility`, `default_branch`, `archived`, and `disabled`. Counts include open, closed, and merged PRs. Records sort by count descending, with unresolved counts last. Failed counts remain `null` in JSON/JSONL or empty in CSV; failures are logged without discarding successful records. CSV has a UTF-8 BOM and preserves exact names.

Console progress prints one JSON line for each unique repository discovered and another when its PR-count processing finishes. Completion messages include the repository name, completed and total counts, PR count, success or unresolved status, and duration in milliseconds. These messages use `console.log` on stdout; the project logger continues to report errors and summaries on stderr.

```sh
npm run job -- github:repositories-pr-counts \
  --config examples/github-repositories-pr-counts.json --format csv
```

Or pass owners directly:

```sh
npm run job -- github:repositories-pr-counts \
  --input '{"owners":["apache","microsoft"]}' --format csv
```

The normal `--output`, `--columns`, and `--overwrite` options apply. Without `--output`, the runner creates a unique file in `OUTPUT_DIR` and prints its absolute path. Like other jobs, the CLI loads `GITHUB_TOKEN` from `.env` and supports cancellation. For a fixed output filename, add `--output data/exports/github-repositories-pr-counts.csv`; add `--overwrite` to replace an existing file.

The collector uses at most three PR-count workers and the shared HTTP retries and rate-limit cooldowns. Owners with failed listings are reported as incomplete; repositories discovered before a later page failure are preserved. It cannot enumerate private repositories owned by another regular user through the public user listing endpoint. See [repository export behavior and access limits](../README.md#export-repositories-with-total-pr-counts).

## Pull request dataset from repository CSV

Name: `github:pull-requests-export`. Run it like any other job:

```sh
npm run job -- github:pull-requests-export \
  --config examples/github-pull-requests-export.json --format csv \
  --output data/exports/github-pull-requests.csv
```

| Input                  | Type             | Default  | Meaning                                       |
| ---------------------- | ---------------- | -------- | --------------------------------------------- |
| `inputCsvPath`         | String           | Required | CSV from `github:repositories-pr-counts`      |
| `order`                | `asc` or `desc`  | Required | Rank by the CSV's numeric PR counts           |
| `limit`                | Positive integer | Required | Maximum number of repositories                |
| `outputCsvPath`        | String           | Unset    | Destination; `--output` takes precedence      |
| `includeDetailedStats` | Boolean          | `false`  | Retrieve additions, deletions, files, commits |

The reader supports quoted cells, embedded newlines, doubled quotes, and an optional UTF-8 BOM. All eight repository-count CSV headers are required. Blank or invalid PR counts are excluded from ranking and their record count is logged. Counts must be nonnegative safe integers. Repository identifiers must agree; contradictory duplicates fail. Identical repository records are deduplicated case-insensitively. Equal counts sort by repository name, ignoring case. Empty eligible selection fails before GitHub requests.

`limit` counts repositories. Every selected repository is retrieved with `state=all`, 100 records per page, creation order ascending, and `Link` pagination until exhausted. No dates, branches, or merge states are filtered, and the input counts never cap retrieval. Requests run serially through the existing GitHub client, authentication, retries, and rate-limit handling, using API version `2022-11-28`. Optional statistics make one detail request per PR; otherwise their columns stay empty. No related files, commits, reviews, or comments are fetched. Counts unavailable from the list response stay empty.

Each newly fetched PR prints a JSON line through `console.log` on stdout, including repository, PR ID/number, repository index, page, repository PR count, and total PR count. Repository and page summaries go through the project logger on stderr. Count discrepancies with the input CSV are warnings; API or malformed-response failures fail the job without publishing an incomplete CSV. A zero-PR repository completes normally.

CSV output groups repositories in ranking order and PRs in ascending creation order, with number breaking ties within each page. The fixed default column order is:

```text
repository_name,username,full_name,repository_total_pull_requests,visibility,default_branch,archived,disabled,pull_request_id,pull_request_node_id,pull_request_number,pull_request_url,pull_request_api_url,title,body,state,draft,merged,author_association,created_at,updated_at,closed_at,merged_at,author_login,author_id,author_type,head_ref,head_sha,head_repository,base_ref,base_sha,base_repository,merge_commit_sha,comments,review_comments,labels,assignees,requested_reviewers,requested_teams,milestone,locked,maintainer_can_modify,additions,deletions,changed_files,commits
```

Array cells contain JSON arrays of label names, assignee/reviewer logins, or team slugs. Milestones contain their titles. Missing nullable values are empty CSV cells. The shared CSV encoder preserves commas, quotes, and line breaks; formula-like strings receive a leading apostrophe for spreadsheet safety. JSON and JSONL preserve original strings.

CSV exports use `<output>.partial`, `<output>.identities`, and `<output>.checkpoint.json` sidecars, with a lock preventing concurrent runs against the same destination. Each complete page is synced before its checkpoint advances. On failure or cancellation, completed pages remain resumable; uncommitted bytes are discarded on resume. Only compact ID/number indexes for the active repository stay in memory. Normal completion, failure, and Ctrl+C remove the lock. Hard process termination can leave `<output>.lock`, which records the process ID and hostname; remove that lock only after confirming the export process has stopped, then rerun to resume.

To resume, rerun the command with **the same output path and options**. The checkpoint verifies the selected repository metadata, ranking options, detailed-statistics option, API base, and CSV settings. It resumes at the next page and skips previously written PR identities. After all repositories complete, the CSV is published atomically and sidecars are removed. Existing destinations require `--overwrite`; the input CSV is always protected. Files created before the initial checkpoint was written cannot be automatically resumed: choose another output path or remove those orphan sidecars after confirming no export is running.

Without a destination, the runner creates a unique timestamped file in `OUTPUT_DIR` and logs its absolute path when the checkpoint is created. Use that exact path with `--output` after an interruption. `--columns` selects CSV fields; `--format json` and `jsonl` also work, using the normal atomic writer and restarting collection after interruption. They do not use CSV checkpoints. GitHub pagination reflects live responses, rather than an immutable historical snapshot; resumed metadata can reflect different fetch times.

The library function uses the same job and returns the absolute CSV path:

```ts
import { exportGitHubPullRequests, loadEnvironment } from './src/index.js';

loadEnvironment();
const outputPath = await exportGitHubPullRequests({
    inputCsvPath: './github-repositories-pr-counts.csv',
    order: 'desc',
    limit: 50,
    outputCsvPath: './github-pull-requests.csv',
    includeDetailedStats: false,
});
console.log(`CSV exported to: ${outputPath}`);
```

Or run `npx tsx examples/export-github-pull-requests.ts <input.csv> [output.csv]`.

## Repository labels

Name: `github:labels`. Input: `repository` (required), `perPage` (1–100, default 100), and `maxItems` (positive integer or `null`, default 100).

Output includes repository, label ID, name, description, color, default-label flag, and API URL. Use the names in the PR job's `labels` input.

```sh
npm run job -- github:labels --config examples/github-labels.json --format json
```

## Pull request files and commits

Names: `github:pull-request-files` and `github:pull-request-commits`. Both use this input:

```json
{
    "repository": "octocat/Hello-World",
    "pullRequestNumber": 1,
    "perPage": 100,
    "maxItems": null
}
```

`repository` and a positive `pullRequestNumber` are required. `perPage` defaults to 100; `maxItems` defaults to 100. Change the PR number to the one you want to analyze.

The file job exports filenames, previous filenames for renames, statuses, SHAs, additions/deletions/change counts, available patches, and content URLs. GitHub can omit patches for binary or large files; omitted patches stay `null`. The commit job exports SHAs, messages, GitHub authors and committers, recorded names and emails, timestamps, and parent SHAs. Unlinked GitHub users remain `null` while recorded commit metadata is retained.

Both jobs fetch PR details first to determine the expected record count. They verify the emitted count and fail atomically if the list is incomplete or changes during collection. GitHub's PR endpoints provide at most [3,000 files or 250 commits](https://docs.github.com/en/rest/pulls/pulls). A request exceeding those limits fails before fetching the list; an explicitly limited subset remains supported. Collecting more than 250 commits requires a different collection strategy using the repository commits API.

```sh
npm run job -- github:pull-request-files --config examples/github-pull-request-files.json --format jsonl
npm run job -- github:pull-request-commits --config examples/github-pull-request-commits.json --format csv
```

## Generic JSON API

Name: `api:json`.

| Input         | Type                       | Default  | Meaning                                         |
| ------------- | -------------------------- | -------- | ----------------------------------------------- |
| `url`         | HTTP(S) URL                | Required | First endpoint to fetch                         |
| `recordsPath` | String                     | Empty    | Dotted path to the record array or object       |
| `fields`      | Object                     | Unset    | Output field name → dotted source path          |
| `headers`     | Object                     | `{}`     | Literal request headers, for nonsecret values   |
| `headerEnv`   | Object                     | `{}`     | Request header name → environment variable name |
| `pagination`  | `none`, `link`             | `none`   | Follow `Link: ...; rel="next"` headers          |
| `maxPages`    | Positive integer           | `1000`   | Page limit; exceeding it fails the run          |
| `maxItems`    | Positive integer or `null` | `100`    | Maximum emitted records; `null` collects all    |

The selected response must be an array of objects or a single object. Without `fields`, objects retain their original fields and nesting. With `fields`, the job projects values into a new row; missing paths become `null`. Dotted paths can include array indices, such as `labels.0.name`.

For an API returning `{ "data": { "items": [...] } }`:

```json
{
    "url": "https://api.example.com/items",
    "recordsPath": "data.items",
    "fields": {
        "id": "id",
        "author": "user.login",
        "first_label": "labels.0.name"
    },
    "headerEnv": { "X-API-Key": "MY_API_KEY" },
    "pagination": "link",
    "maxItems": null
}
```

Put `MY_API_KEY=...` in `.env`. Missing required environment variables fail before the first request. For bearer authentication, put the entire value, including the `Bearer ` prefix, in the environment variable referenced by `headerEnv.Authorization`.

`api:json` supports a single response and Link pagination. APIs with cursor tokens in the body, GraphQL, POST requests, or domain-specific transformations should use a custom job; see [adding jobs](adding-jobs.md).

## Local example

Name: `example`. Input: `{ "count": 3 }`, with an integer count from 1 to 1000. It yields `id`, `name`, and `source` fields without network access.

```sh
npm run job -- example --input '{"count":5}' --format jsonl
```
