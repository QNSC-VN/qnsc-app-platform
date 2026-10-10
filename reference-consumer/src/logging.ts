import { createLoggerOptions } from '@quynhonsemiconductor/observability';
import { LoggerModule } from 'nestjs-pino';

/**
 * The shared logger, exactly as the package documents it: JSON lines on stdout, the `correlationId`
 * and `trace.id` mixin, the redaction list. The tests read these lines from the child processes'
 * stdout, so what they assert is what an operator's collector would see.
 */
export const loggerModule = (service: string) =>
  LoggerModule.forRoot(
    createLoggerOptions({
      serviceName: service,
      nodeEnv: process.env['NODE_ENV'] ?? 'development',
      serviceVersion: 'm6',
      level: 'info',
      pretty: false,
    }),
  );
