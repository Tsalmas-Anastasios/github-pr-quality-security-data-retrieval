import { z } from 'zod';

export const githubOwnerSchema = z
    .string()
    .max(39)
    .regex(/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/, 'Expected a GitHub user or organization name');
export const githubRepositorySchema = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/, 'Expected owner/repo')
    .refine((value) => !['.', '..'].includes(value.split('/')[1] ?? ''), 'Invalid repository name');

export function parseGitHubRepository(repository: string): {
    owner: string;
    repo: string;
} {
    const parsed = githubRepositorySchema.parse(repository);
    const [owner, repo] = parsed.split('/');
    return { owner: owner!, repo: repo! };
}

/** Build browser URLs separately from the REST API base, including Enterprise hosts. */
export function getGitHubRepositoryUrl(
    repository: string,
    webBaseUrl = 'https://github.com'
): string {
    const { owner, repo } = parseGitHubRepository(repository);
    const base = new URL(webBaseUrl);
    if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
    ) {
        throw new Error(
            'Expected an HTTP(S) GitHub web base URL without credentials, query, or fragment'
        );
    }
    return new URL(
        `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        `${base.href.replace(/\/+$/, '')}/`
    ).href;
}
