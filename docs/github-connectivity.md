# GitHub connectivity and shared helpers

The GitHub setup adapts the thesis project's patterns: centralized connection configuration, shared HTTP requests, reusable timing and error helpers, and separate resource methods. All endpoints here use the same HTTP client for authentication headers, deadlines, cancellation, retries, and pagination.

## Configure the connection

Set the current names in `.env`:

```dotenv
GITHUB_TOKEN=
GITHUB_API_URL=https://api.github.com
GITHUB_API_VERSION=2026-03-10
GITHUB_TIMEOUT_MS=30000
```

The token is optional for public resources. GitHub Enterprise Server can use a URL such as `https://github.example.com/api/v3` and an API version supported by that server. Base URLs must use HTTP(S) without embedded credentials, a query string, or a fragment.

The thesis project's environment names work as fallbacks:

| Thesis project name   | Current name        |
| --------------------- | ------------------- |
| `GITHUB_API__TOKEN`   | `GITHUB_TOKEN`      |
| `GITHUB_API__URL`     | `GITHUB_API_URL`    |
| `GITHUB_API__TIMEOUT` | `GITHUB_TIMEOUT_MS` |

Non-empty current token and URL values take precedence. For the timeout, a supplied current value takes precedence and is validated rather than silently replaced. If neither GitHub timeout name is set, GitHub uses `API_TIMEOUT_MS`, defaulting to 30 seconds. When using the old URL name, remove the current `GITHUB_API_URL` line from `.env` so its default does not override your alias. Environment aliases are implemented here; the reference project is not a runtime dependency.

## Verify connectivity

```sh
npm run github:check
npm run github:check -- --repository octocat/Hello-World
```

Or after building:

```sh
npm start -- github-check --repository octocat/Hello-World
```

The command requests `/rate_limit` and reports each resource's limit, remaining requests, reset epoch, and usage when available. It reports `token_configured`, without printing the token. With a repository, it also verifies metadata and the PR list endpoint with a one-record page. A successful connection alone does not establish access to every private repository; check the target repository explicitly.

## Shared API client

```ts
import { createJobContext, GitHubClient, loadEnvironment } from './src/index.js';

loadEnvironment();
const github = new GitHubClient(createJobContext());
const repository = await github.getRepository('octocat/Hello-World');

for await (const label of github.listLabels(repository.full_name)) {
    console.log(label.name);
}
```

The client provides `getRepository()`, `listRepositories()`, `listPullRequests()`, `getPullRequest()`, `listLabels()`, `listPullRequestFiles()`, `listPullRequestCommits()`, `getRateLimit()`, and `checkConnection()`. List methods yield records page by page. PR file and commit endpoints have API limits; the export jobs add checks against the expected count.

Pagination follows GitHub's `Link` headers, detects repeated URLs, and preserves Enterprise base paths. Redirects and pagination stay on the API's original origin. Tokens are scoped to GitHub requests; generic API jobs configure their own credentials.

## Timing, retry, and error helpers

```ts
import { getErrorMessage, sleep, withTimeout } from './src/index.js';

await sleep(1000, context.signal);

try {
    const data = await withTimeout(
        async (signal) => {
            const response = await fetch(url, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        },
        5000,
        context.signal
    );
    console.log(data);
} catch (error) {
    context.logger.error(getErrorMessage(error));
    throw error;
}
```

`sleep()` is cancellable. `withTimeout()` rejects with `TimeoutError`, signals cancellation to the operation, and clears its timer and parent abort listener on completion. Custom operations should honor the supplied signal to stop their underlying work. HTTP requests already use it around fetching and reading the response body, so custom jobs normally just call `context.http.getJson()` with `context.signal`.

`getHttpRetryDecision()` separates retry policy from transport. It recognizes transient failures, HTTP 429, and GitHub primary and secondary rate limits. It honors numeric or date-form `Retry-After`, the reset epoch, and exponential backoff. A malformed server delay falls back to the rate-limit wait. The client never shortens a required wait to fit `API_MAX_RETRY_DELAY_MS`; it fails with an actionable message if the delay is too long. See [GitHub's retry guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

`parseGitHubRepository()` validates and splits `owner/repo`. `getGitHubRepositoryUrl()` builds a browser URL from a repository name and optional web base, such as an Enterprise hostname. Prefer API-returned `html_url` values when available.
