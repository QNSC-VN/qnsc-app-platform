import {
  type DynamicModule,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { BffService } from './bff.service';
import { BffSessionStore } from './bff-session.store';
import { EntraOidcClient } from './entra-oidc.client';

/**
 * Options for {@link BffModule.forRoot}.
 *
 * The package supplies the BFF collaborators ({@link EntraOidcClient},
 * {@link BffSessionStore}, {@link BffService}); the product supplies what the
 * package cannot know about, via `imports` and/or `providers`:
 *
 * - The {@link BFF_OPTIONS} binding — resolved from the product's own config,
 *   e.g. `{ provide: BFF_OPTIONS, useFactory: (c: AppConfig) => c.bffOptions,
 *   inject: [AppConfig] }`.
 * - Any module the option factory needs (e.g. the product config module) via
 *   `imports`.
 *
 * `AuthService` (from {@link AuthModule}, which is `@Global`) and `CacheService`
 * (from the global cache module) are resolved from the ambient context, so they
 * do not need to be re-imported here.
 *
 * @example
 * ```ts
 * BffModule.forRoot({
 *   imports: [ConfigModule],
 *   providers: [
 *     { provide: BFF_OPTIONS, useFactory: (c: AppConfig) => c.bffOptions, inject: [AppConfig] },
 *   ],
 * });
 * ```
 */
export interface BffModuleOptions extends Pick<ModuleMetadata, 'imports'> {
  /** Product-supplied provider bindings (the {@link BFF_OPTIONS} token, etc.). */
  providers?: Provider[];
}

/**
 * Opt-in module that wires the shared Backend-for-Frontend auth mechanism: the
 * Entra OIDC client, the Valkey-backed session store, and the {@link BffService}
 * orchestrator. Products that expose a BFF import this where their BFF HTTP
 * controller lives and bind {@link BFF_OPTIONS}; products that do not simply
 * never import it.
 */
@Module({})
export class BffModule {
  static forRoot(options: BffModuleOptions = {}): DynamicModule {
    return {
      module: BffModule,
      imports: [...(options.imports ?? [])],
      providers: [
        EntraOidcClient,
        BffSessionStore,
        BffService,
        ...(options.providers ?? []),
      ],
      exports: [BffService, BffSessionStore, EntraOidcClient],
    };
  }
}
