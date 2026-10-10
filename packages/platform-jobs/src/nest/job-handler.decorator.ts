import { SetMetadata } from '@nestjs/common';
import type { HandleOptions } from '../types';

/** The metadata key; a registry symbol so two copies of this package still agree. */
export const JOB_HANDLER_METADATA = Symbol.for('@quynhonsemiconductor/platform-jobs:handler');

export interface JobHandlerMetadata {
  queue: string;
  options: HandleOptions | undefined;
}

/**
 * Marks a provider method as the handler of `queue`. `JobsModule` finds it at startup and calls
 * `jobs.handle()`; the handler runs only when `ROLE=worker`, and the queue is defined in every
 * process so `jobs.send()` works from the API.
 *
 * ```ts
 * @Injectable()
 * export class Mailer {
 *   @JobHandler('mail.send', { concurrency: 4, retention: { completed: 'immediate', failed: 86_400 } })
 *   async send(job: JobContext<MailPayload>): Promise<void> { … }
 * }
 * ```
 *
 * The method must be idempotent: delivery is at-least-once.
 */
export const JobHandler = (queue: string, options?: HandleOptions): MethodDecorator =>
  SetMetadata<symbol, JobHandlerMetadata>(JOB_HANDLER_METADATA, { queue, options });
