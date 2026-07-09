import {
  type DynamicModule,
  type FactoryProvider,
  Global,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { ValkeyService } from './valkey.service';
import { VALKEY_OPTIONS, type ValkeyModuleOptions } from './valkey.types';

/** Async configuration for {@link CacheModule.forRootAsync}. */
export interface ValkeyModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS factory signature
  useFactory: (...args: any[]) => ValkeyModuleOptions | Promise<ValkeyModuleOptions>;
}

/**
 * Global module exposing {@link ValkeyService}. Each product wires its own
 * connection options (URL + key prefix), so runtime state stays per-product —
 * the shared code never implies a shared Valkey instance.
 */
@Global()
@Module({})
export class CacheModule {
  static forRoot(options: ValkeyModuleOptions): DynamicModule {
    return {
      module: CacheModule,
      providers: [{ provide: VALKEY_OPTIONS, useValue: options }, ValkeyService],
      exports: [ValkeyService],
    };
  }

  static forRootAsync(options: ValkeyModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: VALKEY_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    return {
      module: CacheModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, ValkeyService],
      exports: [ValkeyService],
    };
  }
}
