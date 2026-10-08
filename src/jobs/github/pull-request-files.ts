import { GitHubClient, gitHubPullRequestLimits } from '../../clients/github.js';
import { defineJob } from '../../core/job.js';
import {
    checkCollectionLimit,
    pullRequestCollectionInputSchema,
    verifyCollectionCount,
} from './input.js';

export const githubPullRequestFilesJob = defineJob({
    name: 'github:pull-request-files',
    description: 'Fetch changed files and available patches for a GitHub pull request.',
    inputSchema: pullRequestCollectionInputSchema,
    columns: [
        'repository',
        'pull_request_number',
        'filename',
        'previous_filename',
        'status',
        'sha',
        'additions',
        'deletions',
        'changes',
        'patch',
        'blob_url',
        'raw_url',
        'contents_url',
    ],
    async *run(input, context) {
        const github = new GitHubClient(context);
        const details = await github.getPullRequest(input.repository, input.pullRequestNumber);
        const expected = checkCollectionLimit(
            details.changed_files,
            input.maxItems,
            gitHubPullRequestLimits.files,
            'files'
        );
        if (expected === 0) return;
        let count = 0;
        for await (const file of github.listPullRequestFiles(
            input.repository,
            input.pullRequestNumber,
            input.perPage
        )) {
            yield {
                repository: input.repository,
                pull_request_number: input.pullRequestNumber,
                ...file,
                blob_url: file.blob_url ?? null,
                raw_url: file.raw_url ?? null,
                contents_url: file.contents_url ?? null,
            };
            count++;
            if (input.maxItems !== null && count >= input.maxItems) break;
        }
        verifyCollectionCount(count, expected, 'files');
    },
});
