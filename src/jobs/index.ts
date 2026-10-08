import type { Job } from '../core/job.js';
import { jsonApiJob } from './api/json.js';
import { exampleJob } from './example.js';
import { githubPullRequestsJob } from './github/pull-requests.js';
import { githubRepositoriesJob } from './github/repositories.js';
import { githubLabelsJob } from './github/labels.js';
import { githubPullRequestFilesJob } from './github/pull-request-files.js';
import { githubPullRequestCommitsJob } from './github/pull-request-commits.js';

export const jobs: ReadonlyMap<string, Job> = new Map(
    [
        exampleJob,
        githubPullRequestsJob,
        jsonApiJob,
        githubRepositoriesJob,
        githubLabelsJob,
        githubPullRequestFilesJob,
        githubPullRequestCommitsJob,
    ].map((job) => [job.name, job])
);

export function getJob(name: string): Job {
    const job = jobs.get(name);
    if (!job)
        throw new Error(`Unknown job "${name}". Available jobs: ${[...jobs.keys()].join(', ')}`);
    return job;
}
