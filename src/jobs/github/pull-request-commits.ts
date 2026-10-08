import { GitHubClient, gitHubPullRequestLimits } from '../../clients/github.js';
import { defineJob } from '../../core/job.js';
import {
    checkCollectionLimit,
    pullRequestCollectionInputSchema,
    verifyCollectionCount,
} from './input.js';

export const githubPullRequestCommitsJob = defineJob({
    name: 'github:pull-request-commits',
    description: 'Fetch commit metadata and parent SHAs for a GitHub pull request.',
    inputSchema: pullRequestCollectionInputSchema,
    columns: [
        'repository',
        'pull_request_number',
        'sha',
        'url',
        'message',
        'author',
        'author_name',
        'author_email',
        'authored_at',
        'committer',
        'committer_name',
        'committer_email',
        'committed_at',
        'parent_shas',
    ],
    async *run(input, context) {
        const github = new GitHubClient(context);
        const details = await github.getPullRequest(input.repository, input.pullRequestNumber);
        const expected = checkCollectionLimit(
            details.commits,
            input.maxItems,
            gitHubPullRequestLimits.commits,
            'commits'
        );
        if (expected === 0) return;
        let count = 0;
        for await (const commit of github.listPullRequestCommits(
            input.repository,
            input.pullRequestNumber,
            input.perPage
        )) {
            yield {
                repository: input.repository,
                pull_request_number: input.pullRequestNumber,
                sha: commit.sha,
                url: commit.html_url,
                message: commit.commit.message,
                author: commit.author?.login ?? null,
                author_name: commit.commit.author?.name ?? null,
                author_email: commit.commit.author?.email ?? null,
                authored_at: commit.commit.author?.date ?? null,
                committer: commit.committer?.login ?? null,
                committer_name: commit.commit.committer?.name ?? null,
                committer_email: commit.commit.committer?.email ?? null,
                committed_at: commit.commit.committer?.date ?? null,
                parent_shas: commit.parents.map((parent) => parent.sha),
            };
            count++;
            if (input.maxItems !== null && count >= input.maxItems) break;
        }
        verifyCollectionCount(count, expected, 'commits');
    },
});
