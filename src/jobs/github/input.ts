import { z } from 'zod';
import { githubRepositorySchema } from '../../utils/github.js';

export const paginationInput = {
    perPage: z.number().int().min(1).max(100).default(100),
    maxItems: z.number().int().positive().nullable().default(100),
};

export const repositoryCollectionInputSchema = z.strictObject({
    repository: githubRepositorySchema,
    ...paginationInput,
});

export const pullRequestCollectionInputSchema = repositoryCollectionInputSchema.extend({
    pullRequestNumber: z.number().int().positive(),
});

export function checkCollectionLimit(
    total: number | null | undefined,
    maxItems: number | null,
    apiLimit: number,
    resource: string
): number {
    if (total === null || total === undefined)
        throw new Error(
            `GitHub did not return the PR ${resource} count; cannot verify export completeness`
        );
    const expected = Math.min(total, maxItems ?? Infinity);
    if (expected > apiLimit) {
        throw new Error(
            `GitHub's PR endpoint returns at most ${apiLimit} ${resource}; this export needs ${expected}. Set maxItems to ${apiLimit} or lower for a partial dataset.`
        );
    }
    return expected;
}

export function verifyCollectionCount(actual: number, expected: number, resource: string): void {
    if (actual !== expected)
        throw new Error(
            `GitHub returned ${actual} PR ${resource}, but ${expected} were expected; the PR may have changed during collection. Run again.`
        );
}
