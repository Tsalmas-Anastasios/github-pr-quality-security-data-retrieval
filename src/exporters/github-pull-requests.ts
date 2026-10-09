import { runJob } from '../core/runner.js';
import {
    githubPullRequestsExportJob,
    type GitHubPullRequestsExportOptions,
} from '../jobs/github/pull-requests-export.js';

export type { GitHubPullRequestsExportOptions } from '../jobs/github/pull-requests-export.js';

/** Export complete PR histories using the same registered job as the CLI. */
export async function exportGitHubPullRequests(
    options: GitHubPullRequestsExportOptions
): Promise<string> {
    const result = await runJob(githubPullRequestsExportJob, { input: options, format: 'csv' });
    return result.outputPath;
}
