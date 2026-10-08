import { GitHubClient } from '../../clients/github.js';
import { defineJob } from '../../core/job.js';
import { repositoryCollectionInputSchema } from './input.js';

export const githubLabelsJob = defineJob({
    name: 'github:labels',
    description: 'Fetch and export repository labels for dataset filtering.',
    inputSchema: repositoryCollectionInputSchema,
    columns: ['repository', 'id', 'name', 'description', 'color', 'default', 'url'],
    async *run(input, context) {
        const github = new GitHubClient(context);
        let count = 0;
        for await (const label of github.listLabels(input.repository, input.perPage)) {
            yield { repository: input.repository, ...label, url: label.url ?? null };
            count++;
            if (input.maxItems !== null && count >= input.maxItems) return;
        }
    },
});
