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

| Job name                      | Purpose                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `example`                     | Local records to verify setup without network access                                   |
| `github:pull-requests`        | Paginated PR collection, normalized metadata, and optional detailed metrics            |
| `api:json`                    | JSON API collection with record selection, field mapping, and optional Link pagination |
| `github:repositories`         | Repository discovery and metadata for users or organizations                           |
| `github:labels`               | Repository label names, descriptions, and colors                                       |
| `github:pull-request-files`   | Changed files, change counts, and available patches for one PR                         |
| `github:pull-request-commits` | Commit messages, authors, timestamps, and parent SHAs for one PR                       |

See [job inputs and examples](docs/jobs.md) for every supported option. API jobs export at most 100 records by default. Set `maxItems` to `null` to collect all available records. The PR file and commit jobs verify counts and fail if a requested full dataset exceeds GitHub's endpoint limits.

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

GitHub requests run sequentially and follow API pagination links. Temporary network errors, server errors, and rate limits retry with delays; permission errors fail immediately. If a server requires a delay above the configured maximum, the run fails so you can increase it or retry later. This follows [GitHub's API guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

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
