import { z } from 'zod';
import type { JobContext } from '../core/job.js';
import { assertSameOrigin, getNextLink } from './http.js';
import {
    labelSchema,
    githubOwnerResponseSchema,
    pullRequestCommitSchema,
    pullRequestFileSchema,
    pullRequestSchema,
    pullRequestDatasetSchema,
    rateLimitSchema,
    repositorySchema,
    type GitHubLabel,
    type GitHubRateLimit,
    type GitHubRepository,
    type GitHubOwner,
    type PullRequest,
    type PullRequestDataset,
    type PullRequestCommit,
    type PullRequestFile,
} from './github-schemas.js';
import { githubOwnerSchema, parseGitHubRepository } from '../utils/github.js';
import { getBackoffDelay } from '../utils/retry.js';
import { sleep } from '../utils/time.js';

export * from './github-schemas.js';

export const gitHubPullRequestLimits = { files: 3000, commits: 250 } as const;

export interface GitHubPage<T> {
    items: T[];
    url: string;
    nextUrl: string | null;
}

export interface GitHubConnectionResult {
    api_url: string;
    token_configured: boolean;
    rate_limits: GitHubRateLimit['resources'];
    repository?: string;
    pull_requests_readable?: boolean;
}

export class GitHubClient {
    private readonly baseUrl: URL;
    private readonly headers: Record<string, string>;

    constructor(private readonly context: JobContext) {
        this.baseUrl = new URL(`${context.config.GITHUB_API_URL.replace(/\/+$/, '')}/`);
        this.headers = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': context.config.GITHUB_API_VERSION,
        };
        if (context.config.GITHUB_TOKEN)
            this.headers.Authorization = `Bearer ${context.config.GITHUB_TOKEN}`;
    }

    async *listPullRequests(
        repository: string,
        state: 'open' | 'closed' | 'all',
        perPage: number
    ): AsyncIterable<PullRequest> {
        const url = this.repositoryUrl(repository, 'pulls');
        url.search = new URLSearchParams({
            state,
            sort: 'created',
            direction: 'desc',
            per_page: String(perPage),
        }).toString();
        yield* this.paginate(url, pullRequestSchema);
    }

    async getPullRequest(repository: string, number: number): Promise<PullRequest> {
        const response = await this.request(
            this.repositoryUrl(repository, `pulls/${this.pullRequestNumber(number)}`)
        );
        return pullRequestSchema.parse(response.data);
    }

    listPullRequestDatasetPages(
        repository: string,
        nextUrl?: string
    ): AsyncIterable<GitHubPage<PullRequestDataset>> {
        const url = this.repositoryUrl(repository, 'pulls');
        url.search = new URLSearchParams({
            state: 'all',
            sort: 'created',
            direction: 'asc',
            per_page: '100',
            page: '1',
        }).toString();
        return this.paginatePages(url, pullRequestDatasetSchema, nextUrl);
    }

    async getPullRequestDataset(repository: string, number: number): Promise<PullRequestDataset> {
        const response = await this.request(
            this.repositoryUrl(repository, `pulls/${this.pullRequestNumber(number)}`)
        );
        return pullRequestDatasetSchema.parse(response.data);
    }

    async getRepository(repository: string): Promise<GitHubRepository> {
        return repositorySchema.parse((await this.request(this.repositoryUrl(repository))).data);
    }

    async getOwner(owner: string): Promise<GitHubOwner> {
        const name = githubOwnerSchema.parse(owner);
        return this.readOwner(new URL(`users/${encodeURIComponent(name)}`, this.baseUrl));
    }

    async getAuthenticatedOwner(): Promise<GitHubOwner> {
        return this.readOwner(new URL('user', this.baseUrl));
    }

    listAuthenticatedOwnedRepositories(perPage = 100): AsyncIterable<GitHubRepository> {
        const url = new URL('user/repos', this.baseUrl);
        url.search = new URLSearchParams({ affiliation: 'owner', page: '1' }).toString();
        return this.paginate(this.withPerPage(url, perPage), repositorySchema);
    }

    /** Search total_count covers open, closed, and merged PRs without downloading them. */
    async getTotalPullRequests(repository: string): Promise<number> {
        parseGitHubRepository(repository);
        const url = new URL('search/issues', this.baseUrl);
        url.search = new URLSearchParams({
            q: `repo:${repository} is:pr`,
            per_page: '1',
        }).toString();
        const schema = z.object({
            total_count: z.number().int().nonnegative(),
            incomplete_results: z.boolean(),
        });
        for (let attempt = 0; attempt <= this.context.config.API_RETRIES; attempt++) {
            // Transport failures already receive bounded retries in the shared HTTP client.
            const response = await this.request(url);
            const result = schema.safeParse(response.data);
            if (result.success && !result.data.incomplete_results) return result.data.total_count;
            const reason = result.success
                ? 'GitHub search returned incomplete_results: true'
                : 'GitHub search returned a missing or malformed total_count/incomplete_results';
            if (attempt === this.context.config.API_RETRIES) {
                throw new Error(`${reason} after ${attempt + 1} attempt(s)`);
            }
            const waitMs = getBackoffDelay(attempt);
            if (waitMs > this.context.config.API_MAX_RETRY_DELAY_MS) {
                throw new Error(`${reason}; required retry delay exceeds API_MAX_RETRY_DELAY_MS`);
            }
            this.context.logger.warn('Retrying unreliable GitHub PR count', {
                repository,
                reason,
                attempt: attempt + 1,
                waitMs,
            });
            await sleep(waitMs, this.context.signal);
        }
        throw new Error('GitHub search retry limit exhausted');
    }

    listRepositories(
        owner: string,
        ownerType: 'user' | 'organization' = 'user',
        perPage = 100
    ): AsyncIterable<GitHubRepository> {
        const name = githubOwnerSchema.parse(owner);
        const url = new URL(
            `${ownerType === 'organization' ? 'orgs' : 'users'}/${encodeURIComponent(name)}/repos`,
            this.baseUrl
        );
        url.search = new URLSearchParams({
            type: ownerType === 'user' ? 'owner' : 'all',
            sort: 'full_name',
            direction: 'asc',
            page: '1',
        }).toString();
        return this.paginate(this.withPerPage(url, perPage), repositorySchema);
    }

    listLabels(repository: string, perPage = 100): AsyncIterable<GitHubLabel> {
        return this.paginate(
            this.withPerPage(this.repositoryUrl(repository, 'labels'), perPage),
            labelSchema
        );
    }

    listPullRequestFiles(
        repository: string,
        number: number,
        perPage = 100
    ): AsyncIterable<PullRequestFile> {
        return this.paginate(
            this.withPerPage(
                this.repositoryUrl(repository, `pulls/${this.pullRequestNumber(number)}/files`),
                perPage
            ),
            pullRequestFileSchema
        );
    }

    listPullRequestCommits(
        repository: string,
        number: number,
        perPage = 100
    ): AsyncIterable<PullRequestCommit> {
        return this.paginate(
            this.withPerPage(
                this.repositoryUrl(repository, `pulls/${this.pullRequestNumber(number)}/commits`),
                perPage
            ),
            pullRequestCommitSchema
        );
    }

    async getRateLimit(): Promise<GitHubRateLimit> {
        return rateLimitSchema.parse(
            (await this.request(new URL('rate_limit', this.baseUrl))).data
        );
    }

    async checkConnection(repository?: string): Promise<GitHubConnectionResult> {
        if (repository) parseGitHubRepository(repository);
        const rateLimit = await this.getRateLimit();
        const result: GitHubConnectionResult = {
            api_url: this.context.config.GITHUB_API_URL,
            token_configured: Boolean(this.context.config.GITHUB_TOKEN),
            rate_limits: rateLimit.resources,
        };
        if (repository) {
            const details = await this.getRepository(repository);
            const iterator = this.listPullRequests(repository, 'all', 1)[Symbol.asyncIterator]();
            try {
                await iterator.next();
            } finally {
                await iterator.return?.();
            }
            result.repository = details.full_name;
            result.pull_requests_readable = true;
        }
        return result;
    }

    private async *paginate<T>(url: URL, schema: z.ZodType<T>): AsyncIterable<T> {
        for await (const page of this.paginatePages(url, schema)) yield* page.items;
    }

    private async *paginatePages<T>(
        url: URL,
        schema: z.ZodType<T>,
        startUrl?: string
    ): AsyncIterable<GitHubPage<T>> {
        let next: string | undefined = startUrl ?? url.href;
        const visited = new Set<string>();
        while (next) {
            this.context.signal?.throwIfAborted();
            assertSameOrigin(new URL(next), this.baseUrl);
            const current = new URL(next);
            if (current.pathname !== url.pathname)
                throw new Error('GitHub pagination changed the requested resource');
            for (const key of ['state', 'sort', 'direction', 'per_page']) {
                if (current.searchParams.get(key) !== url.searchParams.get(key))
                    throw new Error(`GitHub pagination changed ${key}`);
            }
            if (visited.has(next)) throw new Error('GitHub returned a pagination loop');
            visited.add(next);
            const response = await this.request(new URL(next));
            const items = z.array(schema).parse(response.data);
            this.context.logger.debug('Fetched GitHub API page', {
                resource: url.pathname,
                page: visited.size,
                count: items.length,
            });
            next = getNextLink(response.headers.get('link'), response.url);
            if (next && items.length === 0)
                throw new Error('GitHub returned an empty page with a next link');
            if (response.headers.get('x-ratelimit-remaining') === '0') {
                this.context.logger.warn('GitHub API rate limit exhausted', {
                    reset: response.headers.get('x-ratelimit-reset'),
                });
            }
            yield { items, url: current.href, nextUrl: next ?? null };
        }
    }

    private request(url: URL) {
        return this.context.http.getJson(url, {
            headers: this.headers,
            timeoutMs: this.context.config.GITHUB_TIMEOUT_MS,
            signal: this.context.signal,
        });
    }

    private async readOwner(url: URL): Promise<GitHubOwner> {
        const result = githubOwnerResponseSchema.safeParse((await this.request(url)).data);
        if (!result.success) throw new Error('GitHub returned an invalid user or organization');
        return result.data;
    }

    private withPerPage(url: URL, perPage: number): URL {
        url.searchParams.set('per_page', String(z.number().int().min(1).max(100).parse(perPage)));
        return url;
    }

    private pullRequestNumber(number: number): number {
        return z.number().int().positive().parse(number);
    }

    private repositoryUrl(repository: string, path?: string): URL {
        const { owner, repo } = parseGitHubRepository(repository);
        return new URL(
            `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path ? `/${path}` : ''}`,
            this.baseUrl
        );
    }
}
