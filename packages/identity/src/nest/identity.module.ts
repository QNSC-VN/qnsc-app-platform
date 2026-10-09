import {
  type DynamicModule,
  Inject,
  Module,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import type { Identity } from '../create-identity';
import { registerAuthHandler } from './fastify-mount';
import { AUTH, SessionGuard } from './session.guard';

export interface IdentityModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<string | symbol | (new (...args: never[]) => unknown)>;
  useFactory: (...args: never[]) => Identity | Promise<Identity>;
}

/** Mounts the handler once Nest has its Fastify instance; provides `AUTH` and the global guard. */
@Module({})
export class IdentityModule implements OnModuleInit {
  constructor(
    @Inject(AUTH) private readonly auth: Identity,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}

  async onModuleInit(): Promise<void> {
    await registerAuthHandler(this.host.httpAdapter.getInstance() as FastifyInstance, this.auth);
  }

  static forRootAsync(options: IdentityModuleAsyncOptions): DynamicModule {
    const authProvider: Provider = {
      provide: AUTH,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    return {
      module: IdentityModule,
      global: true,
      imports: options.imports ?? [],
      providers: [authProvider, { provide: APP_GUARD, useClass: SessionGuard }],
      exports: [AUTH],
    };
  }
}
