import { z } from 'zod';
import { GitHubClient } from '../../clients/github.js';
import { defineJob } from '../../core/job.js';
import { githubOwnerSchema } from '../../utils/github.js';
import { paginationInput } from './input.js';

export const githubRepositoriesJob = defineJob({
    name: 'github:repositories',
    description: 'Discover and export repository metadata for GitHub users or organizations.',
    inputSchema: z.strictObject({
        owners: z.array(githubOwnerSchema).min(1),
        ownerType: z.enum(['user', 'organization']).default('user'),
        ...paginationInput,
    }),
    columns: [
        'owner',
        'name',
        'full_name',
        'url',
        'description',
        'language',
        'default_branch',
        'private',
        'fork',
        'archived',
        'disabled',
        'stars',
        'forks',
        'open_issues',
        'created_at',
        'updated_at',
        'pushed_at',
    ],
    async *run(input, context) {
        const github = new GitHubClient(context);
        const seen = new Set<string>();
        for (const owner of new Set(input.owners.map((value) => value.toLowerCase()))) {
            for await (const repository of github.listRepositories(
                owner,
                input.ownerType,
                input.perPage
            )) {
                const key = repository.full_name.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                yield {
                    owner: repository.owner.login,
                    name: repository.name,
                    full_name: repository.full_name,
                    url: repository.html_url,
                    description: repository.description,
                    language: repository.language,
                    default_branch: repository.default_branch,
                    private: repository.private,
                    fork: repository.fork,
                    archived: repository.archived ?? null,
                    disabled: repository.disabled ?? null,
                    stars: repository.stargazers_count ?? null,
                    forks: repository.forks_count ?? null,
                    open_issues: repository.open_issues_count ?? null,
                    created_at: repository.created_at ?? null,
                    updated_at: repository.updated_at ?? null,
                    pushed_at: repository.pushed_at ?? null,
                };
                if (input.maxItems !== null && seen.size >= input.maxItems) return;
            }
        }
    },
});
