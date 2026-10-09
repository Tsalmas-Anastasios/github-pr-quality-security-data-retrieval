# Adding a job

A job is a named async generator. It receives validated input and a context containing configuration, the shared HTTP client, a logger, and an optional cancellation signal. It yields processed objects. `runJob()` sends those objects to the selected exporter.

## Define fetching and processing

Create a file such as `src/jobs/my-api/users.ts`:

```ts
import { z } from 'zod';
import { defineJob } from '../../core/job.js';

export const usersJob = defineJob({
    name: 'my-api:users',
    description: 'Fetch users and prepare a dataset.',
    inputSchema: z.strictObject({
        url: z.url(),
    }),
    columns: ['id', 'name', 'email'],
    async *run(input, context) {
        const response = await context.http.getJson(input.url, {
            signal: context.signal,
        });
        const users = z
            .array(
                z.object({
                    id: z.number(),
                    name: z.string(),
                    email: z.string(),
                })
            )
            .parse(response.data);

        for (const user of users) {
            context.signal?.throwIfAborted();
            yield {
                id: user.id,
                name: user.name.trim(),
                email: user.email.toLowerCase(),
            };
        }
    },
});
```

Use `.js` in relative TypeScript imports. Node's ESM loader will resolve the compiled JavaScript paths; `tsx` resolves them to TypeScript during development.

For APIs requiring multiple requests, keep the pagination loop inside `run()` or create a reusable client in `src/clients/`. Yield records after each page to keep memory use bounded. Pass `context.signal` to every request. Do not catch errors just to continue with incomplete data unless that behavior is explicitly part of the job's contract.

Prefer separate processing functions when transformations become substantial, as the GitHub job does with `processPullRequest()`. Validate API responses with Zod before processing them. Use environment variables for credentials and keep them out of log fields.

## Register the name

Import `usersJob` in `src/jobs/index.ts` and add it to the array used to construct the `jobs` map:

```ts
import { usersJob } from './my-api/users.js';

// Include usersJob alongside the existing definitions.
```

The job will appear in `npm run jobs` and can run through the same CLI:

```sh
npm run job -- my-api:users \
  --input '{"url":"https://jsonplaceholder.typicode.com/users"}' \
  --format csv
```

Export it from `src/index.ts` if you want it available through the public library entry point.

## Call a job directly

Registration is only needed for CLI lookup. From another TypeScript file, pass a definition directly to `runJob()`:

```ts
import { runJob } from './src/core/runner.js';
import { usersJob } from './src/jobs/my-api/users.js';

await runJob(usersJob, {
    input: { url: 'https://jsonplaceholder.typicode.com/users' },
    format: 'csv',
    outputPath: 'data/exports/users.csv',
});
```

Paths in this example are relative to a caller at the repository root. See [`examples/custom-job.ts`](../examples/custom-job.ts) for a complete, runnable file.

The optional third argument to `runJob()` accepts a `config`, `http`, `logger`, or `signal` override to customize the execution context. `job.prepare(input)(context)` returns just the processed record iterator if you want to consume records without writing a file.

A definition can set `csvOptions: { utf8Bom: true, csvEscapeFormulas: false }` when its CSV contract requires a UTF-8 BOM and exact string cells. Normal CSV jobs omit this setting and retain the shared writer's defaults. Explicit options passed to `runJob()` take precedence over a job's CSV defaults.

Jobs with durable export state can provide an optional `export(input, context, options)` function returning the written row count. The runner still validates input, creates the shared context, resolves output flags, and reports success or failure. The ordinary `run()` generator remains available for direct record consumption. An optional `outputPath(input)` supplies a destination from job input; the runner's `--output` takes precedence. `github:pull-requests-export` uses these hooks for page checkpoints in CSV while retaining the normal JSON/JSONL writer.

## Verify the behavior

Format the code, validate its types, and compile it:

```sh
npm run format
npm run check
```

Rebuild before running the compiled CLI. Generated exports and `.env` stay out of Git.
