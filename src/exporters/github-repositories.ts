import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import { createJobContext } from '../core/context.js';
import type { ExportRow } from '../core/job.js';
import {
    collectGitHubRepositoryRows,
    githubRepositoryExportColumns,
    reportGitHubRepositoryFailure,
} from '../jobs/github/repositories-pr-counts.js';
import { exportRows } from './file.js';

export {
    githubRepositoryExportColumns,
    type GitHubRepositoryExportRow,
    type GitHubRepositoryExportSummary,
} from '../jobs/github/repositories-pr-counts.js';

/** Export every discoverable owned repository, retaining failures as empty PR counts. */
export async function exportGitHubRepositories(usernames: string[]): Promise<string> {
    if (!Array.isArray(usernames)) throw new TypeError('Expected an array of GitHub owner names');
    const config = loadConfig({ ...process.env, GITHUB_API_VERSION: '2022-11-28' });
    const context = createJobContext({ config });
    const outputPath = resolve(config.OUTPUT_DIR, 'github-repositories-pr-counts.csv');
    const { rows, summary } = await collectGitHubRepositoryRows(usernames, context);
    async function* records(): AsyncIterable<ExportRow> {
        yield* rows;
    }
    try {
        await exportRows(records(), {
            format: 'csv',
            columns: githubRepositoryExportColumns,
            outputPath,
            overwrite: true,
            utf8Bom: true,
            csvEscapeFormulas: false,
        });
    } catch (error) {
        reportGitHubRepositoryFailure(
            context,
            'Could not write GitHub repository CSV',
            outputPath,
            error
        );
        throw error;
    }
    context.logger.info('GitHub repository export completed', { ...summary, outputPath });
    return outputPath;
}
