import { defineJob, type ExportRow, type JobContext } from '../../core/job.js';
import { exportRows } from '../../exporters/file.js';
import {
    exportPullRequestDatasetCsv,
    protectRepositoryCsv,
} from '../../exporters/github-pull-request-dataset.js';
import { getErrorMessage } from '../../utils/error.js';
import {
    createDatasetClient,
    fetchPullRequestDatasetRow,
    githubPullRequestExportColumns,
    githubPullRequestsExportInputSchema,
    reportRepositoryComplete,
    selectPullRequestRepositories,
    type GitHubPullRequestsExportInput,
} from './pull-requests-dataset.js';

export {
    githubPullRequestExportColumns,
    githubPullRequestsExportInputSchema,
    type GitHubPullRequestsExportOptions,
} from './pull-requests-dataset.js';

async function* collectRows(
    input: GitHubPullRequestsExportInput,
    context: JobContext
): AsyncIterable<ExportRow> {
    const repositories = await selectPullRequestRepositories(input, context);
    const github = createDatasetClient(context);
    let total = 0;
    for (const [index, repository] of repositories.entries()) {
        const seenIds = new Map<number, number>();
        const seenNumbers = new Map<number, number>();
        let count = 0;
        let pageNumber = 0;
        context.logger.info('Processing repository PR history', {
            repository: repository.full_name,
            index: index + 1,
            selected: repositories.length,
            completedRepositories: index,
            failedRepositories: 0,
        });
        try {
            for await (const page of github.listPullRequestDatasetPages(repository.full_name)) {
                pageNumber++;
                page.items.sort(
                    (a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number
                );
                for (const request of page.items) {
                    context.signal?.throwIfAborted();
                    if (seenIds.has(request.id) || seenNumbers.has(request.number)) {
                        if (
                            seenIds.get(request.id) !== request.number ||
                            seenNumbers.get(request.number) !== request.id
                        )
                            throw new Error(
                                `Contradictory PR identity for ${repository.full_name}#${request.number}`
                            );
                        context.logger.warn('Skipping repeated PR from pagination', {
                            repository: repository.full_name,
                            number: request.number,
                        });
                        continue;
                    }
                    yield await fetchPullRequestDatasetRow(repository, request, input, github, {
                        repositoryIndex: index + 1,
                        repositories: repositories.length,
                        repositoryPullRequests: count + 1,
                        totalPullRequests: total + 1,
                        page: pageNumber,
                    });
                    seenIds.set(request.id, request.number);
                    seenNumbers.set(request.number, request.id);
                    count++;
                    total++;
                }
                context.logger.info('PR page fetched', {
                    repository: repository.full_name,
                    page: pageNumber,
                    repositoryPullRequests: count,
                    totalPullRequests: total,
                });
            }
            reportRepositoryComplete(repository, count, context);
        } catch (error) {
            context.logger.error('Repository PR export failed', {
                repository: repository.full_name,
                completedRepositories: index,
                failedRepositories: 1,
                message: getErrorMessage(error),
            });
            throw error;
        }
    }
}

export const githubPullRequestsExportJob = defineJob({
    name: 'github:pull-requests-export',
    description:
        'Rank repositories from a CSV and export their complete PR histories, with CSV resume support.',
    inputSchema: githubPullRequestsExportInputSchema,
    columns: githubPullRequestExportColumns,
    outputPath: (input) => input.outputCsvPath,
    run: collectRows,
    async export(input, context, options) {
        if (options.format === 'csv') return exportPullRequestDatasetCsv(input, context, options);
        await protectRepositoryCsv(input.inputCsvPath, [options.outputPath]);
        return exportRows(collectRows(input, context), options);
    },
});
