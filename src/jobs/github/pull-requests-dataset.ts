import { z } from 'zod';
import { GitHubClient, type PullRequestDataset } from '../../clients/github.js';
import type { ExportRow, JobContext } from '../../core/job.js';
import { githubRepositoryExportColumns } from './repositories-pr-counts.js';
import { githubOwnerSchema, parseGitHubRepository } from '../../utils/github.js';
import { readCsv } from '../../utils/csv.js';

export interface GitHubPullRequestsExportOptions {
    inputCsvPath: string;
    order: 'asc' | 'desc';
    limit: number;
    outputCsvPath?: string;
    includeDetailedStats?: boolean;
}

export const githubPullRequestsExportInputSchema = z.strictObject({
    inputCsvPath: z.string().min(1),
    order: z.enum(['asc', 'desc']),
    limit: z.number().int().positive(),
    outputCsvPath: z.string().min(1).optional(),
    includeDetailedStats: z.boolean().default(false),
});
export type GitHubPullRequestsExportInput = z.infer<typeof githubPullRequestsExportInputSchema>;

export const githubPullRequestExportColumns = [
    'repository_name',
    'username',
    'full_name',
    'repository_total_pull_requests',
    'visibility',
    'default_branch',
    'archived',
    'disabled',
    'pull_request_id',
    'pull_request_node_id',
    'pull_request_number',
    'pull_request_url',
    'pull_request_api_url',
    'title',
    'body',
    'state',
    'draft',
    'merged',
    'author_association',
    'created_at',
    'updated_at',
    'closed_at',
    'merged_at',
    'author_login',
    'author_id',
    'author_type',
    'head_ref',
    'head_sha',
    'head_repository',
    'base_ref',
    'base_sha',
    'base_repository',
    'merge_commit_sha',
    'comments',
    'review_comments',
    'labels',
    'assignees',
    'requested_reviewers',
    'requested_teams',
    'milestone',
    'locked',
    'maintainer_can_modify',
    'additions',
    'deletions',
    'changed_files',
    'commits',
] as const;

export interface SelectedRepository {
    repository_name: string;
    username: string;
    full_name: string;
    repository_total_pull_requests: number;
    visibility: string;
    default_branch: string;
    archived: boolean | null;
    disabled: boolean | null;
}

function csvBoolean(value: string, column: string, record: number): boolean | null {
    if (!value) return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Invalid ${column} at CSV record ${record}`);
}

export async function selectPullRequestRepositories(
    input: GitHubPullRequestsExportInput,
    context: JobContext
): Promise<SelectedRepository[]> {
    let columns: string[] | undefined;
    let record = 0;
    let excluded = 0;
    const unique = new Map<string, { signature: string; repository: SelectedRepository | null }>();
    for await (const fields of readCsv(input.inputCsvPath, context.signal)) {
        record++;
        if (!columns) {
            columns = fields;
            if (new Set(columns).size !== columns.length)
                throw new Error('Input CSV contains duplicate column names');
            const missing = githubRepositoryExportColumns.filter(
                (name) => !columns!.includes(name)
            );
            if (missing.length)
                throw new Error(`Input CSV is missing columns: ${missing.join(', ')}`);
            continue;
        }
        if (fields.length !== columns.length)
            throw new Error(
                `CSV record ${record} has ${fields.length} fields; expected ${columns.length}`
            );
        const row = Object.fromEntries(
            columns.map((column, index) => [column, fields[index] ?? ''])
        );
        const fullName = row.full_name ?? '';
        const { owner, repo } = parseGitHubRepository(fullName);
        githubOwnerSchema.parse(owner);
        if (
            owner.toLowerCase() !== row.username?.toLowerCase() ||
            repo.toLowerCase() !== row.repository_name?.toLowerCase()
        )
            throw new Error(`Repository identifiers contradict full_name at CSV record ${record}`);
        const rawCount = row.total_pull_requests?.trim() ?? '';
        const count =
            /^\d+$/.test(rawCount) && Number.isSafeInteger(Number(rawCount))
                ? Number(rawCount)
                : null;
        if (count === null) excluded++;
        const metadata = {
            repository_name: row.repository_name ?? '',
            username: row.username ?? '',
            full_name: fullName,
            visibility: row.visibility ?? '',
            default_branch: row.default_branch ?? '',
            archived: csvBoolean(row.archived ?? '', 'archived', record),
            disabled: csvBoolean(row.disabled ?? '', 'disabled', record),
        };
        const signature = JSON.stringify({
            ...metadata,
            repository_name: metadata.repository_name.toLowerCase(),
            username: metadata.username.toLowerCase(),
            full_name: fullName.toLowerCase(),
            count: count ?? rawCount,
        });
        const key = fullName.toLowerCase();
        const previous = unique.get(key);
        if (previous && previous.signature !== signature)
            throw new Error(
                `Contradictory duplicate repository: ${fullName} at CSV record ${record}`
            );
        if (!previous)
            unique.set(key, {
                signature,
                repository:
                    count === null ? null : { ...metadata, repository_total_pull_requests: count },
            });
    }
    if (!columns) throw new Error('Input CSV is empty');
    context.logger.info('Repository CSV parsed', {
        records: record - 1,
        excludedInvalidCounts: excluded,
    });
    const repositories = [...unique.values()].flatMap(({ repository }) =>
        repository ? [repository] : []
    );
    repositories.sort((left, right) => {
        const difference =
            left.repository_total_pull_requests - right.repository_total_pull_requests;
        const a = left.full_name.toLowerCase();
        const b = right.full_name.toLowerCase();
        return (input.order === 'asc' ? difference : -difference) || (a < b ? -1 : a > b ? 1 : 0);
    });
    const selected = repositories.slice(0, input.limit);
    if (!selected.length)
        throw new Error('No repositories with valid PR counts are available for selection');
    context.logger.info('Repositories selected for PR export', {
        selected: selected.length,
        eligible: repositories.length,
        order: input.order,
    });
    return selected;
}

export function processPullRequestDataset(
    repository: SelectedRepository,
    request: PullRequestDataset,
    detailed: boolean
): ExportRow {
    const expectedPath = `/repos/${encodeURIComponent(repository.username)}/${encodeURIComponent(repository.repository_name)}/pulls/${request.number}`;
    if (!new URL(request.url).pathname.toLowerCase().endsWith(expectedPath.toLowerCase()))
        throw new Error(`PR ${request.number} has an API URL outside ${repository.full_name}`);
    if (
        request.base.repo &&
        request.base.repo.full_name.toLowerCase() !== repository.full_name.toLowerCase()
    )
        throw new Error(`PR ${request.number} belongs to an unexpected base repository`);
    return {
        ...repository,
        pull_request_id: request.id,
        pull_request_node_id: request.node_id,
        pull_request_number: request.number,
        pull_request_url: request.html_url,
        pull_request_api_url: request.url,
        title: request.title,
        body: request.body,
        state: request.state,
        draft: request.draft,
        merged: request.merged_at !== null,
        author_association: request.author_association,
        created_at: request.created_at,
        updated_at: request.updated_at,
        closed_at: request.closed_at,
        merged_at: request.merged_at,
        author_login: request.user?.login ?? null,
        author_id: request.user?.id ?? null,
        author_type: request.user?.type ?? null,
        head_ref: request.head.ref,
        head_sha: request.head.sha,
        head_repository: request.head.repo?.full_name ?? null,
        base_ref: request.base.ref,
        base_sha: request.base.sha,
        base_repository: request.base.repo?.full_name ?? null,
        merge_commit_sha: request.merge_commit_sha,
        comments: request.comments ?? null,
        review_comments: request.review_comments ?? null,
        labels: request.labels.map((label) => label.name),
        assignees: request.assignees?.map((user) => user.login) ?? null,
        requested_reviewers: request.requested_reviewers?.map((user) => user.login) ?? null,
        requested_teams: request.requested_teams?.map((team) => team.slug) ?? null,
        milestone: request.milestone?.title ?? null,
        locked: request.locked ?? null,
        maintainer_can_modify: request.maintainer_can_modify ?? null,
        additions: detailed ? (request.additions ?? null) : null,
        deletions: detailed ? (request.deletions ?? null) : null,
        changed_files: detailed ? (request.changed_files ?? null) : null,
        commits: detailed ? (request.commits ?? null) : null,
    };
}

export function createDatasetClient(context: JobContext): GitHubClient {
    return new GitHubClient({
        ...context,
        config: { ...context.config, GITHUB_API_VERSION: '2022-11-28' },
    });
}

export async function fetchPullRequestDatasetRow(
    repository: SelectedRepository,
    request: PullRequestDataset,
    input: GitHubPullRequestsExportInput,
    github: GitHubClient,
    progress: {
        repositoryIndex: number;
        repositories: number;
        repositoryPullRequests: number;
        totalPullRequests: number;
        page: number;
    }
): Promise<ExportRow> {
    const data = input.includeDetailedStats
        ? await github.getPullRequestDataset(repository.full_name, request.number)
        : request;
    if (data.id !== request.id || data.number !== request.number)
        throw new Error(
            `PR detail identity mismatch for ${repository.full_name}#${request.number}`
        );
    if (
        input.includeDetailedStats &&
        [data.additions, data.deletions, data.changed_files, data.commits].some(
            (value) => value == null
        )
    )
        throw new Error(
            `Missing detailed statistics for ${repository.full_name}#${request.number}`
        );
    const row = processPullRequestDataset(repository, data, input.includeDetailedStats);
    console.log(
        JSON.stringify({
            time: new Date().toISOString(),
            job: 'github:pull-requests-export',
            message: 'Pull request fetched',
            repository: repository.full_name,
            pullRequestNumber: data.number,
            pullRequestId: data.id,
            ...progress,
        })
    );
    return row;
}

export function reportRepositoryComplete(
    repository: SelectedRepository,
    count: number,
    context: JobContext
): void {
    context.logger.info('Repository PR export completed', {
        repository: repository.full_name,
        pullRequests: count,
    });
    if (count !== repository.repository_total_pull_requests)
        context.logger.warn('Exported PR count differs from input CSV', {
            repository: repository.full_name,
            expected: repository.repository_total_pull_requests,
            exported: count,
        });
}
