import { resolve } from 'node:path';
import { GitHubClient, type GitHubOwner, type GitHubRepository } from '../clients/github.js';
import { loadConfig } from '../config/env.js';
import { createJobContext } from '../core/context.js';
import type { ExportRow, JobContext } from '../core/job.js';
import { getErrorMessage } from '../utils/error.js';
import { githubOwnerSchema } from '../utils/github.js';
import { exportRows } from './file.js';

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

function reportFailure(
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
        let owner: GitHubOwner;
        try {
            owner = await github.getOwner(name);
        } catch (error) {
            reportFailure(
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
                complete = false;
                reportFailure(
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
                    reportFailure(
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
            const repository = repositories[nextIndex++];
            if (!repository) return;
            let total: number | null = null;
            try {
                total = await github.getTotalPullRequests(repository.full_name);
            } catch (error) {
                reportFailure(
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

/** Export every discoverable owned repository, retaining failures as empty PR counts. */
export async function exportGitHubRepositories(usernames: string[]): Promise<string> {
    if (!Array.isArray(usernames)) throw new TypeError('Expected an array of GitHub owner names');
    const config = loadConfig({ ...process.env, GITHUB_API_VERSION: '2022-11-28' });
    const context = createJobContext({ config });
    const github = new GitHubClient(context);
    const outputPath = resolve(config.OUTPUT_DIR, 'github-repositories-pr-counts.csv');
    const owners: string[] = [];
    const seen = new Set<string>();
    for (const name of usernames) {
        const parsed = githubOwnerSchema.safeParse(name);
        if (!parsed.success) {
            reportFailure(
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
    async function* records(): AsyncIterable<ExportRow> {
        yield* rows;
    }
    try {
        await exportRows(records(), {
            format: 'csv',
            columns: githubRepositoryExportColumns,
            outputPath,
            overwrite: true,
            utf8Bom: true,
            csvEscapeFormulas: false,
        });
    } catch (error) {
        reportFailure(context, 'Could not write GitHub repository CSV', outputPath, error);
        throw error;
    }

    const successfulCounts = rows.filter((row) => row.total_pull_requests !== null).length;
    const summary: GitHubRepositoryExportSummary = {
        ownersRequested: usernames.length,
        ownersSuccessfullyProcessed: successfulOwners,
        repositoriesDiscovered: repositories.size,
        successfulPullRequestCounts: successfulCounts,
        unresolvedPullRequestCounts: rows.length - successfulCounts,
        outputPath,
    };
    context.logger.info('GitHub repository export completed', { ...summary });
    return outputPath;
}
