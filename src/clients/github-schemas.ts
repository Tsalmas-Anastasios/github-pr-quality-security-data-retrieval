import { z } from 'zod';
import { githubOwnerSchema } from '../utils/github.js';

const optionalCount = z.number().int().nonnegative().nullish();
const timestamp = z.iso.datetime({ offset: true });
const optionalText = z.string().nullable().default(null);

export const githubOwnerResponseSchema = z.object({
    login: githubOwnerSchema,
    type: z.enum(['User', 'Organization']),
});

export const pullRequestSchema = z.object({
    id: z.number().int(),
    number: z.number().int().positive(),
    html_url: z.url(),
    title: z.string(),
    body: optionalText,
    state: z.enum(['open', 'closed']),
    draft: z.boolean().default(false),
    user: z.object({ login: z.string() }).nullable(),
    created_at: timestamp,
    updated_at: timestamp,
    closed_at: timestamp.nullable(),
    merged_at: timestamp.nullable(),
    head: z.object({ ref: z.string(), sha: z.string() }),
    base: z.object({ ref: z.string(), sha: z.string() }),
    labels: z.array(z.object({ name: z.string() })).default([]),
    additions: optionalCount,
    deletions: optionalCount,
    changed_files: optionalCount,
    commits: optionalCount,
    comments: optionalCount,
    review_comments: optionalCount,
});

export const repositorySchema = z.object({
    id: z.number().int(),
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
    html_url: z.url(),
    description: optionalText,
    language: optionalText,
    default_branch: optionalText,
    private: z.boolean(),
    visibility: z.enum(['public', 'private', 'internal']).optional(),
    fork: z.boolean(),
    archived: z.boolean().nullish(),
    disabled: z.boolean().nullish(),
    stargazers_count: optionalCount,
    forks_count: optionalCount,
    open_issues_count: optionalCount,
    created_at: timestamp.nullish(),
    updated_at: timestamp.nullish(),
    pushed_at: timestamp.nullish(),
});

export const labelSchema = z.object({
    id: z.number().int(),
    name: z.string(),
    color: z.string(),
    description: optionalText,
    default: z.boolean(),
    url: z.url().optional(),
});

export const pullRequestFileSchema = z.object({
    sha: z.string(),
    filename: z.string(),
    status: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    previous_filename: optionalText,
    patch: optionalText,
    blob_url: z.url().nullish(),
    raw_url: z.url().nullish(),
    contents_url: z.url().nullish(),
});

const commitPersonSchema = z.object({
    name: z.string(),
    email: z.string(),
    date: timestamp,
});

export const pullRequestCommitSchema = z.object({
    sha: z.string(),
    html_url: z.url(),
    commit: z.object({
        message: z.string(),
        author: commitPersonSchema.nullable(),
        committer: commitPersonSchema.nullable(),
    }),
    author: z.object({ login: z.string() }).nullable(),
    committer: z.object({ login: z.string() }).nullable(),
    parents: z.array(z.object({ sha: z.string() })),
});

const rateLimitResourceSchema = z.object({
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    reset: z.number().int().nonnegative(),
    used: z.number().int().nonnegative().optional(),
});

export const rateLimitSchema = z.object({
    resources: z.record(z.string(), rateLimitResourceSchema),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;
export type GitHubRepository = z.infer<typeof repositorySchema>;
export type GitHubOwner = z.infer<typeof githubOwnerResponseSchema>;
export type GitHubLabel = z.infer<typeof labelSchema>;
export type PullRequestFile = z.infer<typeof pullRequestFileSchema>;
export type PullRequestCommit = z.infer<typeof pullRequestCommitSchema>;
export type GitHubRateLimit = z.infer<typeof rateLimitSchema>;
