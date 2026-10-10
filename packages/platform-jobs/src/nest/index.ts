import './require-peers';
import { Inject } from '@nestjs/common';
import { JOBS_TOKEN } from './jobs.module';

export { JobsModule, JOBS_TOKEN, JOBS_POOL_TOKEN, type JobsModuleOptions } from './jobs.module';
export { JobHandler, JOB_HANDLER_METADATA, type JobHandlerMetadata } from './job-handler.decorator';

/** Inject the `Jobs` instance. */
export const InjectJobs = () => Inject(JOBS_TOKEN);
