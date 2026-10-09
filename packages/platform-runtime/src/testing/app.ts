import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * A real Nest + Fastify application for tests. Not exported from the package, and excluded from
 * the build in tsconfig.json: it needs `@nestjs/platform-fastify`, a devDependency only.
 */
export async function createTestApp(
  module: Type<unknown>,
  prepare?: (app: NestFastifyApplication) => void,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(module, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  prepare?.(app);
  return app;
}
