# GitHub PR quality and security data retrieval

A TypeScript project for running named data jobs. Each job validates its input, fetches data from an API, processes records, and exports them to CSV, JSON, or JSONL. You can run jobs from the terminal or call the runner from code.

## Get started

Use Node.js **22.12+**; `.nvmrc` selects Node 24. If you use nvm:

```sh
nvm install
nvm use
npm ci
cp .env.example .env
```

Set `GITHUB_TOKEN` in `.env` when you need authenticated GitHub access. Public repository jobs can also run with the token left blank. GitHub fine-grained tokens need **Pull requests: read** for the repositories you collect; see [GitHub's endpoint documentation](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests).

Check the connection and optionally verify access to a specific repository:

```sh
npm run github:check
npm run github:check -- --repository octocat/Hello-World
```

The check reports API rate limits and whether a token is configured. With `--repository`, it verifies repository metadata and PR read access. See [GitHub connectivity and helpers](docs/github-connectivity.md), including compatibility with the thesis project's `GITHUB_API__*` environment names.

List the jobs, then try a local export:

```sh
npm run jobs
npm run job -- example --format csv
```

Exports go to `data/exports/` by default. The command prints a result containing the output path, record count, and duration. Logs go to stderr; the result goes to stdout.

## Run API jobs

Fetch GitHub pull requests using a configuration file:

```sh
npm run job -- github:pull-requests --config examples/github-pull-requests.json --format csv
```

Or pass input directly:

```sh
npm run job -- github:pull-requests \
  --input '{"repository":"microsoft/TypeScript","maxItems":25,"includeDetails":true}' \
  --format json
```

Fetch another JSON API and select fields:

```sh
npm run job -- api:json --config examples/json-api.json --format jsonl
```

Choose an output file and CSV columns:

```sh
npm run job -- github:pull-requests \
  --input '{"repository":"octocat/Hello-World","maxItems":10}' \
  --format csv --columns number,title,author,merged \
  --output data/exports/pull-requests.csv
```

Existing files are protected by default. Add `--overwrite` to replace one after the new run succeeds. `--input` and `--config` are alternatives; configuration files contain the job's input object, not CLI flags.

| Job name                        | Purpose                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `example`                       | Local records to verify setup without network access                                   |
| `github:pull-requests`          | Paginated PR collection, normalized metadata, and optional detailed metrics            |
| `github:pull-requests-export`   | Rank repositories from CSV and export complete PR histories with CSV checkpoints       |
| `api:json`                      | JSON API collection with record selection, field mapping, and optional Link pagination |
| `github:repositories`           | Repository discovery and metadata for users or organizations                           |
| `github:repositories-pr-counts` | All accessible owned repositories with total PR counts across every state              |
| `github:labels`                 | Repository label names, descriptions, and colors                                       |
| `github:pull-request-files`     | Changed files, change counts, and available patches for one PR                         |
| `github:pull-request-commits`   | Commit messages, authors, timestamps, and parent SHAs for one PR                       |

See [job inputs and examples](docs/jobs.md) for every supported option. Most paginated API jobs export at most 100 records by default; set `maxItems` to `null` to collect all available records. `github:repositories-pr-counts` always collects all available repositories. The PR file and commit jobs verify counts and fail if a requested full dataset exceeds GitHub's endpoint limits.

## TypeScript and compiled JavaScript

Development commands run TypeScript through `tsx`. Build once to run plain JavaScript:

```sh
npm run build
npm start -- list
npm start -- run github:pull-requests --config examples/github-pull-requests.json --format csv
```

The compiler writes JavaScript, source maps, and TypeScript declarations to `dist/`. Run `npm run build` again after changing source files when using `npm start`.

You can also call a job from TypeScript:

```ts
import { githubPullRequestsJob, loadEnvironment, runJob } from './src/index.js';

loadEnvironment();
const result = await runJob(githubPullRequestsJob, {
    input: { repository: 'octocat/Hello-World', maxItems: 10 },
    format: 'json',
});
console.log(result.outputPath);
```

Compiled JavaScript callers import from `./dist/index.js`. Library imports do not load `.env` or start jobs automatically. Call `loadEnvironment()` when you want `.env` loaded.

## Export repositories with total PR counts

Run the named job through the same CLI as the other jobs:

```sh
npm run job -- github:repositories-pr-counts \
  --config examples/github-repositories-pr-counts.json --format csv
```

Edit `owners` in the example configuration, or supply the list directly:

```sh
npm run job -- github:repositories-pr-counts \
  --input '{"owners":["apache","microsoft","facebook"]}' --format csv
```

The job automatically detects users and organizations, follows every repository page, and exports one row per repository ID. It includes forks, archived and disabled repositories, and repositories with zero PRs. It uses REST issue search with `repo:owner/repository is:pr` and `per_page=1` to read `total_count` across open, closed, and merged PRs without downloading PR lists. It also supports `--format json` or `jsonl`, `--columns`, `--output`, and `--overwrite`, using the shared runner's output and cancellation behavior. Its default output is a unique file in `OUTPUT_DIR`; the printed result contains the absolute path. To use a fixed CSV filename:

```sh
npm run job -- github:repositories-pr-counts \
  --config examples/github-repositories-pr-counts.json --format csv \
  --output data/exports/github-repositories-pr-counts.csv --overwrite
```

The reusable function `exportGitHubRepositories(usernames: string[]): Promise<string>` uses the same collection code and writes a CSV directly:

```ts
import { exportGitHubRepositories, loadEnvironment } from './src/index.js';

loadEnvironment(); // Optional: load GITHUB_TOKEN and other settings from .env.
const csvPath = await exportGitHubRepositories(['apache', 'microsoft', 'facebook']);
console.log(csvPath); // Absolute file path.
```

Or run the supplied example with any number of owners:

```sh
npx tsx examples/export-github-repositories.ts apache microsoft facebook
```

Configure authentication by setting `GITHUB_TOKEN` in the shell environment or in your ignored `.env` file. The CLI loads `.env` automatically; library callers use `loadEnvironment()`. Leave it unset for public access. For private repositories, the token must cover the selected repositories and satisfy any organization access requirements. Repository listing requires **Metadata: read** for fine-grained tokens; [issue/PR search requires no additional fine-grained permissions](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests). The job and function never print the token and use `Authorization: Bearer`, `Accept: application/vnd.github+json`, and API version `2022-11-28`.

The reusable function writes `data/exports/github-repositories-pr-counts.csv` by default, honoring the project's existing export location. Set `OUTPUT_DIR` to change its directory. A successful function call atomically replaces the previous file; CLI jobs require `--overwrite` to replace an existing file. The CSV contains these columns in this order:

```text
repository_name,username,full_name,total_pull_requests,visibility,default_branch,archived,disabled
```

Counts sort descending; unresolved counts sort last and stay empty. UTF-8 with a BOM and CRLF records supports Excel and other CSV readers. CSV quoting preserves names and escapes commas, quotes, and line breaks. This export preserves exact cell strings, including repository names starting with `-`; other job exports retain their existing formula-string protection.

Duplicate owners are handled case-insensitively. Empty input produces a header-only CSV. Invalid or unavailable owners are reported and other owners continue. If a later repository page fails, repositories from earlier pages remain in the export and that owner is reported as incomplete. An unreliable count (HTTP error, malformed count, or `incomplete_results: true`) is reported individually and stays empty after bounded retries. File-writing failures reject the function and preserve the previous output.

The execution summary goes to stderr using the project logger and includes `ownersRequested` (the original array length), `ownersSuccessfullyProcessed` (unique valid owners whose required listings completed), `repositoriesDiscovered`, `successfulPullRequestCounts`, and `unresolvedPullRequestCounts`. The function includes `outputPath` in its summary; the named job reports the absolute path in the runner's completion log and printed result. Keep `LOG_LEVEL=info` to see the summary.

Repository discovery is sequential; PR counts use at most three workers. The shared HTTP client honors primary and secondary rate limits, shares cooldowns across workers, and respects `Retry-After` and `X-RateLimit-Reset`. Existing timeout, retry-count, and maximum-delay settings apply. Successful requests receive no arbitrary delay. Search has a separate, tighter rate limit; requests needing a wait above `API_MAX_RETRY_DELAY_MS` fail clearly rather than retrying early.

GitHub access limits still apply. Organization listing includes repositories visible to the token. For the authenticated user's own account, public listing is merged with paginated `/user/repos?affiliation=owner` results. [Other users' repository listings expose only public repositories](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user), so this function cannot enumerate arbitrary private repositories owned by another user. Search counts reflect GitHub's search index and may lag recent changes; an incomplete search response is never accepted as a complete count. If all owners fail, the output contains only the header and the summary reports zero successfully processed owners.

## Export a PR dataset from repository counts

Use the repository-count CSV as input to the registered job:

```sh
npm run job -- github:pull-requests-export \
  --config examples/github-pull-requests-export.json --format csv \
  --output data/exports/github-pull-requests.csv
```

Set `inputCsvPath`, `order` (`asc` or `desc`), and `limit` in the example configuration. The limit selects repositories, and the job retrieves every available PR for each selection. Set `includeDetailedStats` to `true` for one additional detail request per PR. Each fetched PR prints a JSON progress line through `console.log`; page and repository summaries go to stderr.

CSV pages are checkpointed on disk, and the final file appears only after all selected repositories complete. Rerun with the same output path and options to resume after an interruption. Existing outputs require `--overwrite`; the input stays unchanged. JSON and JSONL are also available through the normal writer, without resume. See [inputs, CSV columns, and checkpoint behavior](docs/jobs.md#pull-request-dataset-from-repository-csv).

The reusable `exportGitHubPullRequests({ inputCsvPath, order, limit, outputCsvPath?, includeDetailedStats? })` function runs the same job and returns the absolute CSV path. See [`examples/export-github-pull-requests.ts`](examples/export-github-pull-requests.ts).

## Project layout

```text
src/
  cli.ts                     Terminal commands
  index.ts                   Public functions and types
  config/env.ts              Environment loading and validation
  clients/                   HTTP requests and GitHub API access
  core/                      Job definitions, runner, and logging
  jobs/
    index.ts                 Registry of available job names
    example.ts               Local demonstration job
    github/                  PRs, repositories, labels, files, and commits
    api/json.ts              Generic JSON API job
  exporters/file.ts          Streaming CSV, JSON, and JSONL writers
  utils/                     Timeouts, sleep, retries, errors, URLs, and JSON paths
examples/                    Ready-to-use inputs and a custom job example
docs/                        Job reference and extension guide
data/exports/                Generated datasets, ignored by Git
dist/                        Compiled JavaScript, ignored by Git
.github/workflows/ci.yml      Automated checks
```

New jobs belong in `src/jobs/`. Use `defineJob()` to supply a name, input schema, and async generator, then register it in `src/jobs/index.ts`. The runner handles configuration and exports. Follow [the extension guide](docs/adding-jobs.md), or run the complete example with `npx tsx examples/custom-job.ts`.

## Configuration and behavior

Defaults are in [`.env.example`](.env.example). Existing shell environment variables take precedence over `.env`.

| Variable                 | Default                  | Purpose                                                   |
| ------------------------ | ------------------------ | --------------------------------------------------------- |
| `GITHUB_TOKEN`           | Empty                    | Optional GitHub authentication                            |
| `GITHUB_API_URL`         | `https://api.github.com` | GitHub API base; can include an Enterprise `/api/v3` path |
| `GITHUB_API_VERSION`     | `2026-03-10`             | Version header; choose one supported by your server       |
| `OUTPUT_DIR`             | `data/exports`           | Default destination directory                             |
| `LOG_LEVEL`              | `info`                   | `debug`, `info`, `warn`, or `error`                       |
| `API_TIMEOUT_MS`         | `30000`                  | Timeout for each request attempt, including response body |
| `GITHUB_TIMEOUT_MS`      | `API_TIMEOUT_MS`         | Optional GitHub-specific request timeout                  |
| `API_RETRIES`            | `3`                      | Additional attempts after the initial request             |
| `API_MAX_RETRY_DELAY_MS` | `120000`                 | Maximum allowed wait before retrying                      |

GitHub requests follow API pagination links. Temporary network errors, server errors, and rate limits retry with delays; permission errors fail immediately. If a server requires a delay above the configured maximum, the run fails so you can increase it or retry later. This follows [GitHub's API guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

The shared `sleep()`, `withTimeout()`, `getErrorMessage()`, and repository URL helpers are exported from `src/index.ts` for custom jobs. GitHub requests use `GITHUB_TIMEOUT_MS`; other APIs use `API_TIMEOUT_MS`. Timeout helpers cancel requests and clean up timers and abort listeners after completion.

Writers consume records incrementally, with API responses held one page at a time. They write a temporary file beside the destination and publish it when the job completes. A failed or interrupted run cleans up its temporary file and preserves an existing destination. Ctrl+C cancels requests and exports. Hard process termination can leave hidden `.tmp` files.

CSV output uses CRLF lines, quotes special characters, and serializes nested objects and arrays as JSON cells. Formula-like strings receive a leading apostrophe for spreadsheet use; JSON and JSONL preserve the original strings. CSV columns come from the job, `--columns`, or the first record. With inferred columns, newly appearing fields cause an error instead of being discarded; an empty dataset requires explicit columns. `--columns` selects fields only for CSV.

API credentials stay in `.env`, which is ignored by Git. Generic API jobs use their own headers and never inherit `GITHUB_TOKEN`. Redirects and pagination must stay on the original API origin.

Jobs run on demand. To schedule one later, invoke the compiled CLI from cron, a task scheduler, or a CI workflow. The project does not start a background worker or require a database.

## Development checks

```sh
npm run typecheck
npm run format
npm run check
```

`npm run check` validates types, checks formatting, and builds JavaScript. GitHub Actions runs the same checks on pushes and pull requests.
