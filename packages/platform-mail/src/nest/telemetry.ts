import type { MailTelemetry } from '../jobs';

/** Metric names, in one place: dashboards and alerts are written against them. */
export const MAIL_METRIC_NAMES = Object.freeze({
  sent: 'mail.sent',
  duplicates: 'mail.duplicates',
  failures: 'mail.failures',
  pacingWaitMs: 'mail.pacing_wait_ms',
});

const NOOP: MailTelemetry = { sent() {}, duplicate() {}, failed() {}, paced() {} };

interface MeterLike {
  createCounter(name: string, options?: object): { add(value: number, attributes?: object): void };
  createHistogram(
    name: string,
    options?: object,
  ): { record(value: number, attributes?: object): void };
}

/**
 * OpenTelemetry counters through `@quynhonsemiconductor/observability`, when it is installed;
 * a no-op otherwise. Labels are bounded: `category` is the message's category (a short word
 * list the product controls) and `code` is the closed `MailErrorCode` union — never an address,
 * a subject or a provider message.
 */
export function createMailTelemetry(
  load: () => { getMeter(name?: string): MeterLike } = () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional peer
    require('@quynhonsemiconductor/observability') as { getMeter(name?: string): MeterLike },
): MailTelemetry {
  let meter: MeterLike;
  try {
    meter = load().getMeter('platform-mail');
  } catch {
    return NOOP;
  }
  const sent = meter.createCounter(MAIL_METRIC_NAMES.sent, {
    description: 'Emails delivered to the provider',
  });
  const duplicates = meter.createCounter(MAIL_METRIC_NAMES.duplicates, {
    description: 'mail.send attempts skipped because the message was already sent',
  });
  const failures = meter.createCounter(MAIL_METRIC_NAMES.failures, {
    description: 'mail.send attempts that failed, by closed error code',
  });
  const pacing = meter.createHistogram(MAIL_METRIC_NAMES.pacingWaitMs, {
    description: 'Time a send waited for its mailbox slot',
    unit: 'ms',
  });
  return {
    sent: (category) => sent.add(1, { category }),
    duplicate: (category) => duplicates.add(1, { category }),
    failed: (category, code) => failures.add(1, { category, code }),
    paced: (waitedMs) => pacing.record(waitedMs),
  };
}
