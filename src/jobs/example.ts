import { z } from 'zod';
import { defineJob } from '../core/job.js';

export const exampleJob = defineJob({
    name: 'example',
    description: 'Export a small local dataset to try the pipeline without API credentials.',
    inputSchema: z.strictObject({
        count: z.number().int().min(1).max(1000).default(3),
    }),
    columns: ['id', 'name', 'source'],
    async *run(input, context) {
        for (let id = 1; id <= input.count; id++) {
            context.signal?.throwIfAborted();
            yield { id, name: `Example record ${id}`, source: 'local' };
        }
    },
});
