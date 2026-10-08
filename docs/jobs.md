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
