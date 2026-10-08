import { z } from 'zod';
import { defineJob, loadEnvironment, runJob } from '../src/index.js';

// Add this definition to src/jobs/ and register it in src/jobs/index.ts for CLI use.
const myJob = defineJob({
    name: 'my-api:users',
    description: 'Fetch users and select fields for analysis.',
    inputSchema: z.strictObject({ url: z.url() }),
    columns: ['id', 'name', 'email'],
    async *run(input, context) {
        const response = await context.http.getJson(input.url, {
            signal: context.signal,
        });
        const users = z
            .array(z.object({ id: z.number(), name: z.string(), email: z.string() }))
            .parse(response.data);
        for (const user of users) {
            yield {
                id: user.id,
                name: user.name.trim(),
                email: user.email.toLowerCase(),
            };
        }
    },
});

loadEnvironment();
const result = await runJob(myJob, {
    input: { url: 'https://jsonplaceholder.typicode.com/users' },
    format: 'csv',
});
console.log(result);
