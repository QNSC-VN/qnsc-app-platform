import { Inject } from '@nestjs/common';
import { DATABASE_POOL_TOKEN, DATABASE_READ_POOL_TOKEN, DATABASE_TOKEN } from '../tokens';

export { DatabaseModule, type DatabaseModuleOptions } from './database.module';
export { DATABASE_POOL_TOKEN, DATABASE_READ_POOL_TOKEN, DATABASE_TOKEN };

/** Inject the Drizzle instance (a `DbExecutor`). */
export const InjectDatabase = () => Inject(DATABASE_TOKEN);
/** Inject the primary `pg.Pool`. */
export const InjectDatabasePool = () => Inject(DATABASE_POOL_TOKEN);
