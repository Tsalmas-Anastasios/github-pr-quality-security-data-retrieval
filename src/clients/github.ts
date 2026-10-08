import { z } from 'zod';
import type { JobContext } from '../core/job.js';
import { assertSameOrigin, getNextLink } from './http.js';
import {
    labelSchema,
    pullRequestCommitSchema,
    pullRequestFileSchema,
    pullRequestSchema,
    rateLimitSchema,
    repositorySchema,
    type GitHubLabel,
    type GitHubRateLimit,
    type GitHubRepository,
    type PullRequest,
    type PullRequestCommit,
    type PullRequestFile,
} from './github-schemas.js';
import { githubOwnerSchema, parseGitHubRepository } from '../utils/github.js';

export * from './github-schemas.js';

export const gitHubPullRequestLimits = { files: 3000, commits: 250 } as const;

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

    async getRepository(repository: string): Promise<GitHubRepository> {
        return repositorySchema.parse((await this.request(this.repositoryUrl(repository))).data);
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
        let next: string | undefined = url.href;
        const visited = new Set<string>();
        while (next) {
            this.context.signal?.throwIfAborted();
            assertSameOrigin(new URL(next), this.baseUrl);
            if (visited.has(next)) throw new Error('GitHub returned a pagination loop');
            visited.add(next);
            const response = await this.request(new URL(next));
            const items = z.array(schema).parse(response.data);
            this.context.logger.debug('Fetched GitHub API page', {
                resource: url.pathname,
                page: visited.size,
                count: items.length,
            });
            yield* items;
            next = getNextLink(response.headers.get('link'), response.url);
        }
    }

    private request(url: URL) {
        return this.context.http.getJson(url, {
            headers: this.headers,
            timeoutMs: this.context.config.GITHUB_TIMEOUT_MS,
            signal: this.context.signal,
        });
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
