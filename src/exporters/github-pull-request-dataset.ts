import { createHash, randomUUID } from 'node:crypto';
import {
    link,
    mkdir,
    open,
    readFile,
    rename,
    stat,
    unlink,
    type FileHandle,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { JobContext } from '../core/job.js';
import { getErrorMessage } from '../utils/error.js';
import {
    createDatasetClient,
    fetchPullRequestDatasetRow,
    githubPullRequestExportColumns,
    reportRepositoryComplete,
    selectPullRequestRepositories,
    type GitHubPullRequestsExportInput,
} from '../jobs/github/pull-requests-dataset.js';
import { csvCell, type ExportOptions } from './file.js';

const checkpointSchema = z.strictObject({
    version: z.literal(1),
    fingerprint: z.string(),
    csvBytes: z.number().int().nonnegative(),
    identitiesBytes: z.number().int().nonnegative(),
    repositoryIdentityStart: z.number().int().nonnegative(),
    repositoryIndex: z.number().int().nonnegative(),
    nextUrl: z.string().nullable(),
    pages: z.number().int().nonnegative(),
    repositoryCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;

async function fileStat(path: string) {
    try {
        return await stat(path);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
    }
}

/** Protect the source even when --overwrite or filesystem aliases are used. */
export async function protectRepositoryCsv(
    inputPath: string,
    outputPaths: string[]
): Promise<void> {
    const input = await stat(inputPath);
    if (!input.isFile()) throw new Error(`Input CSV is not a regular file: ${inputPath}`);
    for (const path of outputPaths) {
        const output = await fileStat(path);
        if (
            resolve(inputPath) === resolve(path) ||
            (output && input.dev === output.dev && input.ino === output.ino)
        )
            throw new Error(`The input CSV must not be overwritten: ${path}`);
    }
}

async function acquireLock(path: string): Promise<FileHandle> {
    let lock: FileHandle;
    try {
        lock = await open(path, 'wx');
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            throw new Error(
                `Export is locked: ${path}. Remove the lock only after confirming its process has stopped.`
            );
        }
        throw error;
    }
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
        await lock.sync();
        return lock;
    } catch (error) {
        await lock.close();
        await unlink(path);
        throw error;
    }
}

async function saveCheckpoint(path: string, state: Checkpoint): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx');
    try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
        await file.close();
        await rename(temporary, path);
    } finally {
        await file.close();
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
}

async function writeAt(file: FileHandle, text: string, position: number): Promise<number> {
    const buffer = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < buffer.length) {
        const result = await file.write(
            buffer,
            written,
            buffer.length - written,
            position + written
        );
        if (result.bytesWritten === 0) throw new Error('File write made no progress');
        written += result.bytesWritten;
    }
    return buffer.length;
}

async function* readIdentities(
    file: FileHandle,
    start: number,
    end: number,
    signal?: AbortSignal
): AsyncIterable<[number, number]> {
    const buffer = Buffer.alloc(64 * 1024);
    let pending = '';
    let position = start;
    while (position < end) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, end - position),
            position
        );
        if (!bytesRead) throw new Error('PR identity journal ended before its checkpoint');
        position += bytesRead;
        pending += buffer.toString('utf8', 0, bytesRead);
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            const [idText, numberText] = line.split(',');
            const id = Number(idText);
            const number = Number(numberText);
            if (
                !/^\d+,\d+$/.test(line) ||
                !Number.isSafeInteger(id) ||
                id <= 0 ||
                !Number.isSafeInteger(number) ||
                number <= 0
            )
                throw new Error('Invalid PR identity journal; cannot safely resume');
            yield [id, number];
        }
        if (pending.length > 64) throw new Error('Malformed PR identity journal record');
    }
    if (pending) throw new Error('PR identity journal has an incomplete record');
}

/** A bounded page is written and synced before advancing the resumable checkpoint. */
export async function exportPullRequestDatasetCsv(
    input: GitHubPullRequestsExportInput,
    context: JobContext,
    options: ExportOptions
): Promise<number> {
    const output = resolve(options.outputPath);
    const partial = `${output}.partial`;
    const identitiesPath = `${output}.identities`;
    const checkpointPath = `${output}.checkpoint.json`;
    const lockPath = `${output}.lock`;
    await protectRepositoryCsv(input.inputCsvPath, [
        output,
        partial,
        identitiesPath,
        checkpointPath,
        lockPath,
    ]);
    const repositories = await selectPullRequestRepositories(input, context);
    const columns = options.columns ?? githubPullRequestExportColumns;
    if (
        !columns.length ||
        new Set(columns).size !== columns.length ||
        columns.some((column) => !githubPullRequestExportColumns.some((known) => known === column))
    )
        throw new Error('CSV columns must be distinct supported PR dataset columns');
    const fingerprint = createHash('sha256')
        .update(
            JSON.stringify({
                version: 1,
                input: {
                    ...input,
                    inputCsvPath: resolve(input.inputCsvPath),
                    outputCsvPath: output,
                },
                repositories,
                columns,
                utf8Bom: options.utf8Bom ?? false,
                csvEscapeFormulas: options.csvEscapeFormulas ?? true,
                apiUrl: context.config.GITHUB_API_URL,
                apiVersion: '2022-11-28',
            })
        )
        .digest('hex');
    await mkdir(dirname(output), { recursive: true });
    const lock = await acquireLock(lockPath);
    let csv: FileHandle | undefined;
    let identities: FileHandle | undefined;
    let completed = false;
    let activeRepository: string | undefined;
    let completedRepositories = 0;
    try {
        context.signal?.throwIfAborted();
        const exists = await fileStat(checkpointPath);
        let state: Checkpoint;
        if (exists) {
            state = checkpointSchema.parse(JSON.parse(await readFile(checkpointPath, 'utf8')));
            if (state.fingerprint !== fingerprint)
                throw new Error(
                    'Checkpoint does not match the input selection, API, or export options. Use another output path.'
                );
            if (
                state.repositoryIndex > repositories.length ||
                state.repositoryIdentityStart > state.identitiesBytes ||
                state.repositoryCount > state.totalCount ||
                (state.repositoryIndex === repositories.length &&
                    (state.nextUrl || state.repositoryCount || state.pages))
            )
                throw new Error('Checkpoint contains inconsistent progress');
            csv = await open(partial, 'r+');
            identities = await open(identitiesPath, 'r+');
            if (
                (await csv.stat()).size < state.csvBytes ||
                (await identities.stat()).size < state.identitiesBytes
            )
                throw new Error(
                    'Partial export is shorter than its checkpoint; it cannot be safely resumed'
                );
            await csv.truncate(state.csvBytes);
            await identities.truncate(state.identitiesBytes);
            context.logger.info('Resuming PR dataset export', {
                outputPath: output,
                completedRepositories: state.repositoryIndex,
                totalPullRequests: state.totalCount,
                nextPage: state.nextUrl,
            });
        } else {
            if ((await fileStat(output)) && !options.overwrite)
                throw new Error(
                    `Output file already exists: ${output}. Choose another path or use --overwrite.`
                );
            state = {
                version: 1,
                fingerprint,
                csvBytes: 0,
                identitiesBytes: 0,
                repositoryIdentityStart: 0,
                repositoryIndex: 0,
                nextUrl: null,
                pages: 0,
                repositoryCount: 0,
                totalCount: 0,
            };
            csv = await open(partial, 'wx');
            identities = await open(identitiesPath, 'wx');
            const header = `${options.utf8Bom ? '\uFEFF' : ''}${columns.map((column) => csvCell(column)).join(',')}\r\n`;
            await csv.writeFile(header);
            state.csvBytes = Buffer.byteLength(header);
            await csv.sync();
            await identities.sync();
            await saveCheckpoint(checkpointPath, state);
            context.logger.info('PR dataset checkpoint created', {
                outputPath: output,
                checkpointPath,
            });
        }
        completedRepositories = state.repositoryIndex;
        let csvBytes = state.csvBytes;
        let identitiesBytes = state.identitiesBytes;
        const seenIds = new Map<number, number>();
        const seenNumbers = new Map<number, number>();
        for await (const [id, number] of readIdentities(
            identities,
            state.repositoryIdentityStart,
            state.identitiesBytes,
            context.signal
        )) {
            if (seenIds.has(id) || seenNumbers.has(number))
                throw new Error('Duplicate identity in PR journal; cannot safely resume');
            seenIds.set(id, number);
            seenNumbers.set(number, id);
        }
        if (seenIds.size !== state.repositoryCount)
            throw new Error('PR identity journal does not match checkpoint count');
        const csvFile = csv;
        const identitiesFile = identities;
        const commit = async (): Promise<void> => {
            await csvFile.sync();
            await identitiesFile.sync();
            state.csvBytes = csvBytes;
            state.identitiesBytes = identitiesBytes;
            await saveCheckpoint(checkpointPath, state);
        };
        const github = createDatasetClient(context);
        while (state.repositoryIndex < repositories.length) {
            context.signal?.throwIfAborted();
            const repository = repositories[state.repositoryIndex];
            if (!repository) throw new Error('Missing selected repository');
            activeRepository = repository.full_name;
            context.logger.info('Processing repository PR history', {
                repository: activeRepository,
                index: state.repositoryIndex + 1,
                selected: repositories.length,
                completedRepositories: state.repositoryIndex,
                failedRepositories: 0,
            });
            // A checkpoint with pages but no next URL already finished this repository.
            if (!state.pages || state.nextUrl) {
                for await (const page of github.listPullRequestDatasetPages(
                    activeRepository,
                    state.nextUrl ?? undefined
                )) {
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
                                    `Contradictory PR identity for ${activeRepository}#${request.number}`
                                );
                            context.logger.warn('Skipping repeated PR from pagination', {
                                repository: activeRepository,
                                number: request.number,
                            });
                            continue;
                        }
                        const row = await fetchPullRequestDatasetRow(
                            repository,
                            request,
                            input,
                            github,
                            {
                                repositoryIndex: state.repositoryIndex + 1,
                                repositories: repositories.length,
                                repositoryPullRequests: state.repositoryCount + 1,
                                totalPullRequests: state.totalCount + 1,
                                page: state.pages + 1,
                            }
                        );
                        const record = `${columns.map((column) => csvCell(row[column], options.csvEscapeFormulas ?? true)).join(',')}\r\n`;
                        const identity = `${request.id},${request.number}\n`;
                        csvBytes += await writeAt(csvFile, record, csvBytes);
                        identitiesBytes += await writeAt(identitiesFile, identity, identitiesBytes);
                        seenIds.set(request.id, request.number);
                        seenNumbers.set(request.number, request.id);
                        state.repositoryCount++;
                        state.totalCount++;
                    }
                    state.pages++;
                    state.nextUrl = page.nextUrl;
                    await commit();
                    context.logger.info('PR page exported', {
                        repository: activeRepository,
                        page: state.pages,
                        repositoryPullRequests: state.repositoryCount,
                        totalPullRequests: state.totalCount,
                        hasNextPage: Boolean(page.nextUrl),
                    });
                }
            }
            reportRepositoryComplete(repository, state.repositoryCount, context);
            state.repositoryIndex++;
            state.repositoryCount = 0;
            state.pages = 0;
            state.nextUrl = null;
            state.repositoryIdentityStart = identitiesBytes;
            await commit();
            seenIds.clear();
            seenNumbers.clear();
            completedRepositories = state.repositoryIndex;
            activeRepository = undefined;
        }
        context.signal?.throwIfAborted();
        await csv.close();
        await identities.close();
        const destination = await fileStat(output);
        const source = await stat(partial);
        const alreadyPublished =
            destination && destination.dev === source.dev && destination.ino === source.ino;
        if (!alreadyPublished) {
            if (options.overwrite) {
                const publish = `${output}.${randomUUID()}.tmp`;
                try {
                    await link(partial, publish);
                    await rename(publish, output);
                } finally {
                    await unlink(publish).catch((error: NodeJS.ErrnoException) => {
                        if (error.code !== 'ENOENT') throw error;
                    });
                }
            } else {
                await link(partial, output);
            }
        }
        completed = true;
        await unlink(checkpointPath);
        await unlink(partial);
        await unlink(identitiesPath);
        context.logger.info('PR dataset export completed', {
            outputPath: output,
            completedRepositories,
            failedRepositories: 0,
            totalPullRequests: state.totalCount,
        });
        return state.totalCount;
    } catch (error) {
        context.logger.error('PR dataset export incomplete', {
            repository: activeRepository,
            completedRepositories,
            failedRepositories: activeRepository ? 1 : 0,
            checkpointPath,
            outputPath: output,
            message: getErrorMessage(error),
        });
        throw error;
    } finally {
        await csv?.close();
        await identities?.close();
        await lock.close();
        await unlink(lockPath);
        if (!completed)
            context.logger.info('Rerun with the same output path and options to resume', {
                outputPath: output,
            });
    }
}
