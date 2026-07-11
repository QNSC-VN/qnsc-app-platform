import {
  type DynamicModule,
  type FactoryProvider,
  Global,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { CacheService } from './cache.service';
import { CACHE_OPTIONS, type CacheModuleOptions } from './cache.types';

/** Async configuration for {@link CacheModule.forRootAsync}. */
export interface CacheModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS factory signature
  useFactory: (...args: any[]) => CacheModuleOptions | Promise<CacheModuleOptions>;
}

/**
 * Global module exposing {@link CacheService}. Each product wires its own
 * connection options (URL + key prefix + mode), so runtime state stays
 * per-product — the shared code never implies a shared Valkey instance.
 */
@Global()
@Module({})
export class CacheModule {
  static forRoot(options: CacheModuleOptions): DynamicModule {
    return {
      module: CacheModule,
      providers: [{ provide: CACHE_OPTIONS, useValue: options }, CacheService],
      exports: [CacheService],
    };
  }

  static forRootAsync(options: CacheModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: CACHE_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    return {
      module: CacheModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, CacheService],
      exports: [CacheService],
    };
  }
}
