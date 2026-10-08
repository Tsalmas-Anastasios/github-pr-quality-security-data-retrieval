import { z } from 'zod';
import { GitHubClient, type GitHubOwner, type GitHubRepository } from '../../clients/github.js';
import { defineJob, type ExportRow, type JobContext } from '../../core/job.js';
import { getErrorMessage } from '../../utils/error.js';
import { githubOwnerSchema } from '../../utils/github.js';

export const githubRepositoryExportColumns = [
    'repository_name',
    'username',
    'full_name',
    'total_pull_requests',
    'visibility',
    'default_branch',
    'archived',
    'disabled',
] as const;

export interface GitHubRepositoryExportRow extends ExportRow {
    repository_name: string;
    username: string;
    full_name: string;
    total_pull_requests: number | null;
    visibility: 'public' | 'private' | 'internal';
    default_branch: string | null;
    archived: boolean | null;
    disabled: boolean | null;
}

export interface GitHubRepositoryExportSummary {
    ownersRequested: number;
    ownersSuccessfullyProcessed: number;
    repositoriesDiscovered: number;
    successfulPullRequestCounts: number;
    unresolvedPullRequestCounts: number;
    outputPath: string;
}

const pullRequestConcurrency = 3;

export function reportGitHubRepositoryFailure(
    context: JobContext,
    message: string,
    resource: string,
    error: unknown
): void {
    // Never include response bodies or request headers in diagnostics.
    const token = context.config.GITHUB_TOKEN;
    const detail = getErrorMessage(error);
    context.logger.error(message, {
        resource: token ? resource.replaceAll(token, '[REDACTED]') : resource,
        error: token ? detail.replaceAll(token, '[REDACTED]') : detail,
    });
}

async function discoverRepositories(
    owners: string[],
    github: GitHubClient,
    context: JobContext,
    repositories: Map<number, GitHubRepository>
): Promise<number> {
    let successfulOwners = 0;
    let authenticatedOwner: GitHubOwner | undefined;
    let authenticationChecked = false;

    for (const name of owners) {
        context.signal?.throwIfAborted();
        let owner: GitHubOwner;
        try {
            owner = await github.getOwner(name);
        } catch (error) {
            context.signal?.throwIfAborted();
            reportGitHubRepositoryFailure(
                context,
                'Could not resolve GitHub owner; continuing with other owners',
                name,
                error
            );
            continue;
        }

        let complete = true;
        const collect = async (source: AsyncIterable<GitHubRepository>): Promise<void> => {
            try {
                for await (const repository of source) {
                    if (repository.owner.login.toLowerCase() === owner.login.toLowerCase()) {
                        repositories.set(repository.id, repository);
                    }
                }
            } catch (error) {
                context.signal?.throwIfAborted();
                complete = false;
                reportGitHubRepositoryFailure(
                    context,
                    'Repository listing failed; preserving repositories already discovered',
                    owner.login,
                    error
                );
            }
        };

        await collect(
            github.listRepositories(
                owner.login,
                owner.type === 'Organization' ? 'organization' : 'user'
            )
        );

        if (owner.type === 'User' && context.config.GITHUB_TOKEN) {
            if (!authenticationChecked) {
                authenticationChecked = true;
                try {
                    authenticatedOwner = await github.getAuthenticatedOwner();
                } catch (error) {
                    context.signal?.throwIfAborted();
                    reportGitHubRepositoryFailure(
                        context,
                        'Could not identify authenticated account; private user repository discovery is unavailable. Check GITHUB_TOKEN and its permissions',
                        'authenticated account',
                        error
                    );
                }
            }
            if (!authenticatedOwner) complete = false;
            if (authenticatedOwner?.login.toLowerCase() === owner.login.toLowerCase()) {
                await collect(github.listAuthenticatedOwnedRepositories());
            }
        }
        if (complete) successfulOwners++;
    }
    return successfulOwners;
}

async function countPullRequests(
    repositories: GitHubRepository[],
    github: GitHubClient,
    context: JobContext
): Promise<GitHubRepositoryExportRow[]> {
    const rows: GitHubRepositoryExportRow[] = [];
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (nextIndex < repositories.length) {
            context.signal?.throwIfAborted();
            const repository = repositories[nextIndex++];
            if (!repository) return;
            let total: number | null = null;
            try {
                total = await github.getTotalPullRequests(repository.full_name);
            } catch (error) {
                context.signal?.throwIfAborted();
                reportGitHubRepositoryFailure(
                    context,
                    'Could not determine PR count; exporting an empty count',
                    repository.full_name,
                    error
                );
            }
            rows.push({
                repository_name: repository.name,
                username: repository.owner.login,
                full_name: repository.full_name,
                total_pull_requests: total,
                visibility: repository.visibility ?? (repository.private ? 'private' : 'public'),
                default_branch: repository.default_branch,
                archived: repository.archived ?? null,
                disabled: repository.disabled ?? null,
            });
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(pullRequestConcurrency, repositories.length) }, worker)
    );
    rows.sort((left, right) => {
        if (left.total_pull_requests === null && right.total_pull_requests !== null) return 1;
        if (right.total_pull_requests === null && left.total_pull_requests !== null) return -1;
        return (
            (right.total_pull_requests ?? 0) - (left.total_pull_requests ?? 0) ||
            left.full_name.localeCompare(right.full_name)
        );
    });
    return rows;
}

/** Shared collection for the named job and the reusable CSV export function. */
export async function collectGitHubRepositoryRows(
    usernames: string[],
    context: JobContext
): Promise<{
    rows: GitHubRepositoryExportRow[];
    summary: Omit<GitHubRepositoryExportSummary, 'outputPath'>;
}> {
    if (!Array.isArray(usernames)) throw new TypeError('Expected an array of GitHub owner names');
    context.signal?.throwIfAborted();
    const github = new GitHubClient({
        ...context,
        config: { ...context.config, GITHUB_API_VERSION: '2022-11-28' },
    });
    const owners: string[] = [];
    const seen = new Set<string>();
    for (const name of usernames) {
        const parsed = githubOwnerSchema.safeParse(name);
        if (!parsed.success) {
            reportGitHubRepositoryFailure(
                context,
                'Skipping invalid GitHub owner',
                String(name),
                new Error('Expected 1–39 letters or digits, with single hyphens between them')
            );
            continue;
        }
        const key = parsed.data.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        owners.push(parsed.data);
    }

    const repositories = new Map<number, GitHubRepository>();
    const successfulOwners = await discoverRepositories(owners, github, context, repositories);
    const rows = await countPullRequests([...repositories.values()], github, context);
    context.signal?.throwIfAborted();
    const successfulCounts = rows.filter((row) => row.total_pull_requests !== null).length;
    return {
        rows,
        summary: {
            ownersRequested: usernames.length,
            ownersSuccessfullyProcessed: successfulOwners,
            repositoriesDiscovered: repositories.size,
            successfulPullRequestCounts: successfulCounts,
            unresolvedPullRequestCounts: rows.length - successfulCounts,
        },
    };
}

export const githubRepositoriesPrCountsJob = defineJob({
    name: 'github:repositories-pr-counts',
    description: 'Discover all owned repositories and export total PR counts across all states.',
    inputSchema: z.strictObject({ owners: z.array(z.string()) }),
    columns: githubRepositoryExportColumns,
    csvOptions: { utf8Bom: true, csvEscapeFormulas: false },
    async *run(input, context) {
        const { rows, summary } = await collectGitHubRepositoryRows(input.owners, context);
        context.logger.info('GitHub repository collection completed', { ...summary });
        yield* rows;
    },
});
