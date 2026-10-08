import { exportGitHubRepositories, loadEnvironment } from '../src/index.js';

loadEnvironment();
const owners = process.argv.slice(2);
if (owners.length === 0) {
    throw new Error(
        'Usage: npx tsx examples/export-github-repositories.ts apache microsoft facebook'
    );
}
const csvPath = await exportGitHubRepositories(owners);
console.log(csvPath);
