import {
  type DynamicModule,
  Global,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EntraTokenVerifier } from './entra-verifier';
import { JwtAuthGuard } from './jwt.guard';
import { JwtStrategy } from './jwt.strategy';
import { PermissionGuard } from './permission.guard';

/**
 * Options for {@link AuthModule.forRoot}.
 *
 * The package supplies its own collaborators (`AuthService`, `EntraTokenVerifier`,
 * the Passport `JwtStrategy`, and the `JwtAuthGuard` / `PermissionGuard`) and the
 * bundled {@link AuthController}. The product supplies the pieces the package
 * cannot know about, via `imports` and/or `providers`:
 *
 * - The persistence port bindings — `USER_REPOSITORY`, `AUTH_SESSION_REPOSITORY`,
 *   `SSO_CONNECTION_REPOSITORY`, `TRANSACTION_RUNNER`.
 * - The collaborator services — `ACCESS_SERVICE`, `WORKSPACE_SERVICE`,
 *   `AUDIT_SERVICE`, the `CLAIMS_PROVIDER` (the product's authorization-claims
 *   adapter), and the `AUTH_CONTEXT` adapter.
 * - The option tokens — `AUTH_SERVICE_OPTIONS`, `JWT_STRATEGY_OPTIONS`,
 *   `ENTRA_VERIFIER_OPTIONS`.
 * - `JwtService` (via `JwtModule`) and `ValkeyService` (via `CacheModule`).
 *
 * Async configuration is expressed through the product's own `useFactory`
 * providers / imported modules, so no separate `forRootAsync` is needed.
 *
 * @example
 * ```ts
 * AuthModule.forRoot({
 *   imports: [PersistenceModule, AccessModule, WorkspaceModule, JwtModule.registerAsync(...)],
 *   providers: [
 *     { provide: AUTH_SERVICE_OPTIONS, useFactory: (c: AppConfig) => c.authOptions, inject: [AppConfig] },
 *     { provide: JWT_STRATEGY_OPTIONS, useFactory: (c: AppConfig) => c.jwtOptions, inject: [AppConfig] },
 *     { provide: ENTRA_VERIFIER_OPTIONS, useFactory: (c: AppConfig) => c.entraOptions, inject: [AppConfig] },
 *     { provide: AUTH_CONTEXT, useExisting: RequestContextService },
 *   ],
 * });
 * ```
 */
export interface AuthModuleOptions extends Pick<ModuleMetadata, 'imports'> {
  /** Product-supplied provider bindings (port implementations + option tokens). */
  providers?: Provider[];
  /** Register the bundled {@link AuthController}. Defaults to `true`. */
  controller?: boolean;
}

/**
 * Global module that wires the shared identity stack: the refresh-rotation
 * `AuthService`, Entra token verification, the Passport JWT strategy, the JWT
 * auth + permission guards, and the cookie-based {@link AuthController}.
 *
 * Kept `@Global` so `@Auth()` / `@Public()` guards resolve on any product
 * feature module after a single root import — mirroring `CacheModule`. Each
 * product still binds its own repositories, services and options, so no runtime
 * state is shared across products.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      imports: [PassportModule, ...(options.imports ?? [])],
      controllers: options.controller === false ? [] : [AuthController],
      providers: [
        AuthService,
        EntraTokenVerifier,
        JwtStrategy,
        JwtAuthGuard,
        PermissionGuard,
        ...(options.providers ?? []),
      ],
      exports: [AuthService, EntraTokenVerifier, JwtAuthGuard, PermissionGuard],
    };
  }
}
