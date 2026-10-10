import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import type { Database } from '@quynhonsemiconductor/platform-db/drizzle';
import { withTransaction } from '@quynhonsemiconductor/platform-db/drizzle';
import { InjectDatabase } from '@quynhonsemiconductor/platform-db/nest';
import { describe, expect, it } from 'vitest';
import { PermanentJobError, type JobContext, type Jobs } from './index';
import { InjectJobs, JOB_HANDLER_METADATA, JobHandler } from './nest';

/**
 * The README's quick start, verbatim apart from the schema. It exists to be COMPILED: the types
 * come from the package root and the decorators from `/nest`, and `pnpm typecheck` fails the day
 * the README imports something that is not exported from where it says.
 */
const schema = {};
export type AppSchema = typeof schema;

@Injectable()
class Invoices {
  constructor(
    @InjectDatabase() private readonly db: Database<AppSchema>,
    @InjectJobs() private readonly jobs: Jobs,
  ) {}

  async place(order: { id: string }) {
    await withTransaction(this.db, async (tx) => {
      await this.jobs.send(
        'invoice.render',
        { orderId: order.id },
        { tx, idempotencyKey: `order:${order.id}` },
      );
    });
  }

  @JobHandler('invoice.render', { concurrency: 4 })
  async render(job: JobContext<{ orderId: string }>): Promise<void> {
    if (!job.data.orderId) throw new PermanentJobError('no order id');
  }
}

describe('the README quick start', () => {
  it('compiles, and its handler is discoverable', () => {
    const metadata = Reflect.getMetadata(JOB_HANDLER_METADATA, Invoices.prototype.render) as {
      queue: string;
    };
    expect(metadata.queue).toBe('invoice.render');
    expect(typeof Invoices.prototype.place).toBe('function');
    expect(schema).toEqual({});
  });
});
