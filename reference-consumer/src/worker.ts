import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { enableGracefulShutdown } from '@quynhonsemiconductor/platform-runtime';
import { Logger } from 'nestjs-pino';
import { infraImports } from './infra';

/** `ROLE=worker`: runs the `mail.send` handler. No HTTP server, so only the shutdown half applies. */
@Module({ imports: infraImports('m6-worker') })
class WorkerModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  enableGracefulShutdown(app);
  app.get(Logger).log({ msg: 'worker ready', pid: process.pid });
}

main().catch((error: unknown) => {
  process.stderr.write(`worker failed to start: ${String(error)}\n`);
  process.exit(1);
});
