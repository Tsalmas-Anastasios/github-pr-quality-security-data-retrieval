import { z } from 'zod';
import { GitHubClient, type PullRequest } from '../../clients/github.js';
import { defineJob, type ExportRow } from '../../core/job.js';
import { githubRepositorySchema } from '../../utils/github.js';

export const githubPullRequestsInputSchema = z
    .strictObject({
        repository: githubRepositorySchema,
        state: z.enum(['open', 'closed', 'all']).default('all'),
        perPage: z.number().int().min(1).max(100).default(100),
        maxItems: z.number().int().positive().nullable().default(100),
        includeDetails: z.boolean().default(false),
        labels: z.array(z.string().trim().min(1)).default([]),
        createdAfter: z.iso.datetime({ offset: true }).optional(),
        createdBefore: z.iso.datetime({ offset: true }).optional(),
    })
    .refine(
        (input) =>
            !input.createdAfter ||
            !input.createdBefore ||
            Date.parse(input.createdAfter) <= Date.parse(input.createdBefore),
        {
            message: 'createdAfter must precede createdBefore',
            path: ['createdAfter'],
        }
    );

export type GitHubPullRequestsInput = z.infer<typeof githubPullRequestsInputSchema>;

export const pullRequestColumns = [
    'repository',
    'id',
    'number',
    'title',
    'body',
    'state',
    'draft',
    'author',
    'url',
    'created_at',
    'updated_at',
    'closed_at',
    'merged_at',
    'merged',
    'time_to_merge_hours',
    'head_branch',
    'head_sha',
    'base_branch',
    'base_sha',
    'labels',
    'additions',
    'deletions',
    'changed_files',
    'commits',
    'comments',
    'review_comments',
] as const;

export function processPullRequest(repository: string, request: PullRequest): ExportRow {
    return {
        repository,
        id: request.id,
        number: request.number,
        title: request.title,
        body: request.body,
        state: request.state,
        draft: request.draft,
        author: request.user?.login ?? null,
        url: request.html_url,
        created_at: request.created_at,
        updated_at: request.updated_at,
        closed_at: request.closed_at,
        merged_at: request.merged_at,
        merged: request.merged_at !== null,
        time_to_merge_hours: request.merged_at
            ? (Date.parse(request.merged_at) - Date.parse(request.created_at)) / 3_600_000
            : null,
        head_branch: request.head.ref,
        head_sha: request.head.sha,
        base_branch: request.base.ref,
        base_sha: request.base.sha,
        labels: request.labels.map((label) => label.name),
        additions: request.additions ?? null,
        deletions: request.deletions ?? null,
        changed_files: request.changed_files ?? null,
        commits: request.commits ?? null,
        comments: request.comments ?? null,
        review_comments: request.review_comments ?? null,
    };
}

export const githubPullRequestsJob = defineJob({
    name: 'github:pull-requests',
    description:
        'Fetch, normalize, and export GitHub pull requests, with optional detailed metrics.',
    inputSchema: githubPullRequestsInputSchema,
    columns: pullRequestColumns,
    async *run(input, context) {
        const github = new GitHubClient(context);
        let count = 0;
        for await (const request of github.listPullRequests(
            input.repository,
            input.state,
            input.perPage
        )) {
            context.signal?.throwIfAborted();
            const created = Date.parse(request.created_at);
            if (input.createdBefore && created > Date.parse(input.createdBefore)) continue;
            // The API is sorted by creation descending, so every later row is older.
            if (input.createdAfter && created < Date.parse(input.createdAfter)) return;
            const labels = new Set(request.labels.map((label) => label.name.toLowerCase()));
            if (!input.labels.every((label) => labels.has(label.toLowerCase()))) continue;
            const data = input.includeDetails
                ? await github.getPullRequest(input.repository, request.number)
                : request;
            yield processPullRequest(input.repository, data);
            count++;
            if (input.maxItems !== null && count >= input.maxItems) return;
        }
    },
});
