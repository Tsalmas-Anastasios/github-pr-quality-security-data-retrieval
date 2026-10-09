import { exportGitHubPullRequests, loadEnvironment } from '../src/index.js';

loadEnvironment();
const [inputCsvPath, outputCsvPath] = process.argv.slice(2);
if (!inputCsvPath)
    throw new Error(
        'Usage: npx tsx examples/export-github-pull-requests.ts <input.csv> [output.csv]'
    );
const outputPath = await exportGitHubPullRequests({
    inputCsvPath,
    order: 'desc',
    limit: 50,
    includeDetailedStats: false,
    ...(outputCsvPath ? { outputCsvPath } : {}),
});
console.log(`CSV exported to: ${outputPath}`);
