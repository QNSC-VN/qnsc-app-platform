# @quynhonsemiconductor/platform-mail

Email **transport** for QNSC product backends: the `EmailSender` contract, a Microsoft Graph
transport (one mailbox and the product's own Entra app per product), a non-production SMTP
transport, and the `mail.send` queue handler that sends through them — paced to the mailbox's
limit, and never sending the same message twice.

| in this package                                         | in your product                                     |
| ------------------------------------------------------- | --------------------------------------------------- |
| `EmailSender` + `EmailMessage` (what identity v8 binds) | templates, copy, locale: you render, we send        |
| `graph` transport, `smtp` transport (non-production)    | which mailbox is yours, and its Exchange RBAC       |
| `mail.send` handler: idempotency, pacing, retry         | when to email at all (in-app first, digests)        |
| `/testing`: in-memory sender, conformance suites        | bounce handling (later ADR), marketing (never here) |

Email decision (APP-PLATFORM-PLAN APD-13): **all** mail goes through Microsoft Graph from the
product's own shared mailbox. Cloudflare Email Service and Resend are future transports behind this
same contract, built only when a product hits a trigger; neither exists here.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

```bash
pnpm add @quynhonsemiconductor/platform-mail @quynhonsemiconductor/platform-jobs @quynhonsemiconductor/observability
pnpm add @azure/identity                      # MAIL_TRANSPORT=graph
pnpm add nodemailer                           # MAIL_TRANSPORT=smtp (development, CI)
pnpm add @nestjs/common @nestjs/core          # /nest
```

`platform-jobs` and `observability` are **required** peers: the queue handler imports
`PermanentJobError` and the job context from them, and the published types name `platform-jobs`'
`Jobs`, `SendOptions` and `JobContext`. The rest are optional because no entry point needs all of
them; a transport's library is needed only when that transport is selected, and **no declaration
names `nodemailer`, `@azure/identity` or `pg-boss`**, so a product that installs none of them still
compiles. `/nest` without `@nestjs/common` throws a message naming it.

| import                                        | what                                                               | framework |
| --------------------------------------------- | ------------------------------------------------------------------ | --------- |
| `@quynhonsemiconductor/platform-mail`         | contract, `createEmailSender`, `registerMailJobs`, Valkey state    | none      |
| `@quynhonsemiconductor/platform-mail/nest`    | `MailModule.forRoot / forRootAsync`, `MailService`, `EMAIL_SENDER` | NestJS    |
| `@quynhonsemiconductor/platform-mail/testing` | `MemoryEmailSender`, `MemoryMailState`, conformance suites         | vitest    |

## Environment

Configuration comes from the environment only; there are no options besides it.

| variable                     | for   | notes                                                                                         |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `MAIL_TRANSPORT`             | all   | `graph` or `smtp`. **Required** — no silent default                                           |
| `MAIL_GRAPH_SENDER`          | graph | the product's shared mailbox, e.g. `noreply-academy@qnsc.vn`                                  |
| `AZURE_TENANT_ID`            | graph | Entra tenant                                                                                  |
| `AZURE_CLIENT_ID`            | graph | the product's **own** Entra app (the one its staff login already uses)                        |
| `AZURE_FEDERATED_TOKEN_FILE` | graph | projected ServiceAccount token: workload identity federation, **no stored secret**. Preferred |
| `AZURE_CLIENT_SECRET`        | graph | local testing only — **refused when `NODE_ENV=production`**                                   |
| `MAIL_SMTP_HOST` / `_PORT`   | smtp  | default `localhost` / `1025` (Mailpit)                                                        |
| `MAIL_SMTP_FROM`             | smtp  | default `noreply@localhost.test`                                                              |

- The federated token wins whenever it is set, even next to a client secret: a pod may keep its
  login flow's secret while its mail uses the federated credential.
- `smtp` **refuses to load when `NODE_ENV=production`**: the factory throws, and the module itself
  throws at `require` time (the check runs before `nodemailer` is loaded). The package root does not
  export it.

## Sending

```ts
import { createEmailSender } from '@quynhonsemiconductor/platform-mail';

const sender = createEmailSender(); // from the environment; throws naming what is missing

await sender.send({
  to: 'user@example.com',
  subject: 'Verify your email',
  html: '<p>…</p>',
  text: '…',
  category: 'auth.verify-email',
  idempotencyKey: 'verify-email:<userId>:<sha256(token)>',
});
```

`send()` is the §4.3 case 2 pattern ("the step is only valid once delivery succeeded"): pass your own
deadline, `send(message, { signal: AbortSignal.timeout(5000) })`. **Never call it inside an open
database transaction.** Everything else goes through the queue.

`EmailMessage`: `to`, `cc?`, `bcc?`, `replyTo?`, `from?`, `subject`, `html`, `text`, `headers?`,
`category`, `idempotencyKey`, `correlationId?`. Addresses are bare `local@domain` strings (no display names, no control characters — nothing
to parse, nothing for a header-injection payload to hide in). Validation runs first, before any
network call or database write: a bad message throws `MailSendError('invalid_message')` naming the
field and never echoing its value.

| field            | rule                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| recipients       | ≤ 500 across `to` / `cc` / `bcc` (Exchange Online), each ≤ 254 chars                  |
| `from`           | omitted, or **exactly the configured mailbox** (another mailbox is spoofing or a 403) |
| `headers`        | names start with `x-` (Graph accepts nothing else), ≤ 10, no control characters       |
| `category`       | lower-case words joined by `.` `-` `_`, ≤ 64 chars: it is a **metric label**          |
| `idempotencyKey` | non-empty, ≤ 512 chars, no control characters                                         |

The result is `{ id, transport }`. Graph answers `202` with no body, so `id` is Graph's `request-id`
(or the `client-request-id` this package sent): for tracing, not for lookup. identity's port expects
`{ id }`; the extra field is harmless.

### Errors

Every failure is a `MailSendError` with a closed `code` (a metric label), `retryable`, and when
the provider gave them `status`, `retryAfterSeconds`, `requestId`. The text never contains the
subject, a recipient, the body or a credential — only the code, the status and Microsoft's request id.

| `code`              | meaning                                              | retryable |
| ------------------- | ---------------------------------------------------- | --------- |
| `invalid_message`   | failed validation, or the provider returned 400      | no        |
| `unauthenticated`   | no token, or 401                                     | yes       |
| `forbidden`         | 403: the app may not send from this mailbox          | no        |
| `mailbox_not_found` | 404                                                  | no        |
| `too_large`         | 413                                                  | no        |
| `throttled`         | 429, or the mailbox is at its sending rate           | yes       |
| `unavailable`       | 5xx                                                  | yes       |
| `network`           | no response                                          | yes       |
| `timeout`           | no response in time, or aborted by the caller        | yes       |
| `config`            | mis-configuration (`MailConfigError`); nothing tried | no        |

### Throttling

Inside one `send()` the Graph transport retries `429`, `502`, `503` and `504` — responses on which
Graph did **not** accept the message, so retrying cannot duplicate it — up to 3 attempts, honouring
`Retry-After` (seconds or HTTP date) up to 30 s, else exponential backoff with jitter. A longer
`Retry-After` is not waited out: the error carries `retryAfterSeconds` and is thrown. Nothing
reschedules the job for that long; what happens next is the queue's section below (a mailbox-wide
cooldown, then the job's own retry backoff).
While it waits, the transport calls `options.onThrottled(seconds)` **before** sleeping; the `mail.send`
handler uses it to start the mailbox-wide cooldown at once, so the other workers stop sending the
moment one is throttled, not when it gives up. A timeout, a dropped connection or a plain `500` are **not** retried in place: Graph may have
accepted the message, so that decision belongs to the caller (the queue's ledger is the guard).

## The `mail.send` queue

```ts
import { createValkeyMailState, registerMailJobs } from '@quynhonsemiconductor/platform-mail';

// every process (API and worker): platform-jobs records the queue everywhere and runs the handler
// only when ROLE=worker. The order against jobs.start() does not matter: registered before it, the
// handler is started by start(); registered after, it is started at once.
const mail = await registerMailJobs(jobs, {
  sender: createEmailSender(),
  state: createValkeyMailState(cache.instance), // platform-cache CacheService.instance, or any ioredis
});

await withTransaction(db, async (tx) => {
  await createUser(tx, user);
  await mail.enqueue(message, { tx }); // rolled back with the transaction: no user, no email
});
```

An API process that only enqueues needs no credentials and no ledger: `createMailQueue(jobs)`. It
**defines** `mail.send` with `MAIL_QUEUE_CONFIG`, the one definition the worker uses too, so a pod
that never runs the handler (identity enqueuing auth mail) creates the queue identically —
`platform-jobs` throws when a queue is defined twice differently. It resolves once the queue exists.

`jobs.send` without `tx` commits on its own connection, independently of any transaction you have
open: pass `tx` whenever the email belongs to a business write.

### What the handler does

For each job, in this order:

1. **Validates** the payload (a malformed one never succeeds: it dead-letters at once).
2. **Claims the ledger entry for the message _before_ sending.** Already sent → finish without
   sending ("a duplicate key produces one email"). Another attempt holds the claim → fail retryably.
3. **Waits for a send slot** on the sender mailbox — a token bucket of **20 a minute, burst 5**, shared
   by every worker (on the server's clock). At most 5 + 20 = 25 leave in any minute, under Exchange
   Online's ~30. While the mailbox is in a **cooldown** (below) no slot is granted. A wait beyond
   2 minutes gives the job back instead of holding the worker.
4. **Sends.** On success records it in the ledger (7 days). If _recording_ fails it logs and moves on:
   throwing would retry and send it again.
5. On failure **releases the claim**; if the provider throttled (`429`), starts the **mailbox-wide
   cooldown** for its `Retry-After` (60 s if it gave none, at most 10 min) so every worker stops,
   not only the one that was told; then rethrows.

### Queue settings (`MAIL_QUEUE_CONFIG`, `MAIL_HANDLE_OPTIONS`)

| setting                                                     | value                                                                         | why                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention`                                                 | completed `'immediate'`, failed 24 h, dead letter 24 h                        | the payload carries bearer links in clear: nothing of a sent mail stays, a failure stays a day (ADR 0001 decision 3, identity ADR 0002 decision 4)                                                                      |
| `expireInSeconds`                                           | 300                                                                           | the ceiling on one attempt, including its wait for a slot                                                                                                                                                               |
| `heartbeatSeconds`                                          | 30, set explicitly                                                            | a killed worker's job is recovered in about a heartbeat plus the monitor pass, not at the end of the lease (ADR 0001 F4)                                                                                                |
| claim lease (`MAIL_CLAIM_LEASE_SECONDS`)                    | 60 s, **renewed every 30 s** while the send runs (`MAIL_CLAIM_RENEW_SECONDS`) | a live attempt keeps its claim for as long as it works; a dead worker's claim lapses within a minute, not at the end of the five-minute ceiling                                                                         |
| `retryLimit` / `retryDelaySeconds` / `retryDelayMaxSeconds` | 10 / 10 s / 900 s                                                             | the retry window is **at least an hour** in the worst case of pg-boss's jittered backoff (`minRetryWindowSeconds()` ≈ 66 min): a ten-minute Valkey outage or sustained throttling must not dead-letter a password reset |
| `concurrency` / polling                                     | 1 / 1 s                                                                       | the mailbox is paced to a few a minute, so parallelism buys nothing; an OTP is picked up within about a second                                                                                                          |
| priority                                                    | `auth.*` = 10, everything else 0                                              | see below                                                                                                                                                                                                               |

A worker killed mid-send stops renewing, so its claim lapses within a minute. `platform-jobs`
notices the death after about a minute and a quarter (the heartbeat plus its monitor pass), by which
time the claim is usually already free: the redelivery sends. Measured with a real SIGKILLed worker
process (`jobs.sigkill.test.ts`): the message went out **88 seconds after the kill**, with no
bounce. With the earlier 330-second lease the same kill cost four redeliveries bouncing off the dead
worker's claim and a mail that arrived about **nine minutes** late — a 15-minute reset link with six
left. A redelivery that does meet a live claim fails retryably and is counted as
`mail.failures{code="in_flight"}` and logged, so a bounce is never invisible.

### Priority

`enqueue()` defaults the queue priority by category: **`auth.*` is 10, everything else 0**. A
verification link or a password reset with a person waiting goes ahead of anything queued before
it; digests and notifications stay at 0 so a bulk run cannot delay a login. Pass `{ priority }` to
override. Bulk mail MUST stay at 0.

### Failures

- **Permanent** (`invalid_message`, `forbidden`, `mailbox_not_found`, `too_large` — HTTP 400, 403,
  404, 413): the handler throws `PermanentJobError`, so the job is **dead-lettered at once, with no
  retries**. The stored text is the code, the HTTP status and Microsoft's request id; logs carry the
  code only.
  What happens to the dead letter:
  - **Alert on `pgboss.queue.jobs{queue="mail.send.dlq",state="ready"} > 0`.** That is the signal; the
    dead-letter copy is deleted after 24 h.
  - **Authentication mail is never redriven.** Its link expires, and the user asks for a new one;
    redriving a stale reset link only emails someone a dead link.
  - Other categories wait for a redrive API in `platform-jobs` (not built yet). Until then a
    dead-lettered digest or notification is lost after 24 h, and the alert is how you find out.
- **Retryable** (`unauthenticated`, `throttled`, `unavailable`, `network`, `timeout`): thrown as they
  are; the queue retries with its backoff.
- A throttled mailbox is not retried into: the cooldown makes every send wait out the `Retry-After`
  first. `retryAfterSeconds` does **not** reschedule the job; it sets the cooldown.

### Why a ledger in Valkey and not `jobs.once`

`platform-jobs`' `once()` guards a _database_ effect: its marker row and the effect share one
transaction, and it holds that transaction and the row lock for as long as the effect runs. Here the
effect is an HTTP request to Graph, which PLAN §4.3 forbids inside an open transaction, and it
cannot be made atomic with the marker anyway. So the handler keeps its own **claim ledger**
(claim → call → record), in the product's own Valkey. `platform-jobs` deduplicates on the job id,
but a completed `mail.send` job is deleted at once, and with it that guard; the ledger is what stops a
re-enqueue after completion, a redelivery of the same job and two workers racing. It is keyed by the
sender mailbox and a hash of the idempotency key, and adds no table to the product's database (P6).

### What it cannot do

- **Exactly-once delivery.** Graph has no idempotency key. A message Graph accepted whose
  acknowledgement is lost is sent again by the retry. The ledger shrinks that window to "the process
  died between Graph's 202 and the ledger write"; it cannot close it. For a verification email a
  duplicate is the better failure than a loss.
- **Work without Valkey.** If the ledger is unreachable the attempt fails (and is retried) rather than
  sending without the guard.

## NestJS

```ts
import { JobsModule } from '@quynhonsemiconductor/platform-jobs/nest';
import { MailModule, MailService } from '@quynhonsemiconductor/platform-mail/nest';

@Module({
  imports: [
    JobsModule.forRoot(),
    MailModule.forRootAsync({
      imports: [CacheModule],
      inject: [CacheService],
      useFactory: (cache: CacheService) => ({ state: createValkeyMailState(cache.instance) }),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class SignUp {
  constructor(private readonly mail: MailService) {}
  // …
  await this.mail.enqueue(message, { tx });
}
```

`MailModule` registers its handler with **`@JobHandler(MAIL_QUEUE, MAIL_HANDLE_OPTIONS)`**, so
`JobsModule` finds it, registers it and then starts pg-boss: the order is not yours to get wrong.
`MailService` takes `JOBS_TOKEN` (`@InjectJobs()` is the same provider) and defines the queue in
every process. `EMAIL_SENDER` is the token identity's `EmailSender` port binds to. A `ROLE=worker`
process without `state` **fails the boot**, not the first job. `MailModuleOptions.sender` replaces
the transport built from the environment (a transport this package does not have, or a test double)
and is **refused when `NODE_ENV=production`** unless `allowCustomSenderInProduction: true`: it
bypasses every guard the built-in transports have, and a test double left in a production module
drops every authentication email while every health check stays green. `MemoryEmailSender` cannot
even be constructed under `NODE_ENV=production`.

With `@quynhonsemiconductor/observability` installed it records `mail.sent`, `mail.duplicates`,
`mail.failures` (labels `category`, `code` — the closed error codes plus `in_flight`) and `mail.pacing_wait_ms`.

## Setting up a product mailbox (once, by an owner)

Each product has **one** shared mailbox (`noreply-<product>@qnsc.vn`) and uses its **one existing
Entra app**, authorised for that mailbox **only** through _Exchange Online RBAC for Applications_
(a management scope on the mailbox's `PrimarySmtpAddress` and the role _Application Mail.Send_).
**Never grant tenant-wide Graph `Mail.Send`** to the app: it bypasses the scope and lets one product
send as any mailbox. This package assumes only the scoped grant — a send from another product's
mailbox must come back `403`.

## Verifying a mailbox (manual; needs real credentials, which this repo never holds)

With one product's app, its own mailbox must return `202` and another product's must return `403`.
RBAC changes can take a while to apply. Run these yourself; export the variables first.

```bash
export AZURE_TENANT_ID=… AZURE_CLIENT_ID=… AZURE_CLIENT_SECRET=…   # the product's app, dev tenant
export TO=you@qnsc.vn                                               # a mailbox you can read
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" \
  -d client_id="$AZURE_CLIENT_ID" -d client_secret="$AZURE_CLIENT_SECRET" \
  -d scope=https://graph.microsoft.com/.default -d grant_type=client_credentials | jq -r .access_token)

check() {  # $1 = the mailbox to send FROM
  curl -s -o /tmp/graph-body.json -w "$1 -> HTTP %{http_code}\n" -X POST \
    "https://graph.microsoft.com/v1.0/users/$1/sendMail" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"message":{"subject":"platform-mail check","body":{"contentType":"Text","content":"ok"},
         "toRecipients":[{"emailAddress":{"address":"'"$TO"'"}}]},"saveToSentItems":false}'
  jq -r '.error.code // empty' /tmp/graph-body.json
}
check noreply-academy@qnsc.vn   # THIS product's mailbox  -> expect HTTP 202
check noreply-rova@qnsc.vn      # ANOTHER product's        -> expect HTTP 403 (ErrorAccessDenied)
```

The same through this package (build first), so the transport itself is what is checked:

```bash
for sender in noreply-academy@qnsc.vn noreply-rova@qnsc.vn; do
  MAIL_TRANSPORT=graph MAIL_GRAPH_SENDER=$sender NODE_ENV=development \
  node -e "
    const { createEmailSender } = require('@quynhonsemiconductor/platform-mail');
    createEmailSender().send({ to: process.env.TO, subject: 'platform-mail check', html: '<p>ok</p>',
      text: 'ok', category: 'manual.check', idempotencyKey: 'manual:' + Date.now() })
      .then((r) => console.log(process.env.MAIL_GRAPH_SENDER, 'sent', r.id))
      .catch((e) => console.log(process.env.MAIL_GRAPH_SENDER, e.code, e.status, e.message));"
done
# expect: noreply-academy… sent <request-id>      noreply-rova… forbidden 403 Graph sendMail failed: HTTP 403 ErrorAccessDenied …
```

In the cluster (workload identity, no secret): `kubectl exec` into a pod of the product and run the
second snippet with `MAIL_TRANSPORT=graph` and `NODE_ENV=production`; the credential is the projected
token at `AZURE_FEDERATED_TOKEN_FILE`.

## Testing

Unit-test your own code against the doubles; test the queue behaviour against the real
`platform-jobs` and PostgreSQL, as this package does (`jobs.integration.test.ts`: rollback ⇒ no
email, duplicate key ⇒ one email, a permanent error ⇒ dead-lettered once with no retry, priority).

```ts
import { MemoryEmailSender, MemoryMailState } from '@quynhonsemiconductor/platform-mail/testing';
import { drainQueue } from '@quynhonsemiconductor/platform-jobs/testing';

const sender = new MemoryEmailSender('noreply@example.test');
const mail = await registerMailJobs(jobs, { sender, state: new MemoryMailState() });
await jobs.start();

await withTransaction(db, async (tx) => {
  await mail.enqueue(message, { tx });
  throw new Error('rollback');
}).catch(() => undefined);
await drainQueue(jobs, MAIL_QUEUE);
expect(sender.sent).toHaveLength(0); // enqueue-in-rollback ⇒ no email
```

- `MemoryEmailSender` validates exactly like the real transports, refuses another `from`, and can
  `failNext({ kind: 'throttled' | 'unavailable' | 'forbidden' })`. It does not deduplicate — no
  transport does.
- `MemoryMailState` takes a clock, so a test can cross a lease, refill the bucket or end a cooldown
  without sleeping. One process only; production uses `createValkeyMailState`.
- `describeEmailSenderConformance({ name, create })` — run it against any transport you write
  (needs vitest globals). `describeMailStateConformance` does the same for a `MailState`.
- The in-memory stand-in for `platform-jobs` that earlier drafts shipped is gone: it could not show
  what the real queue does with a transaction, retention or a dead letter.

## Known limits

- **Graph carries one body part.** `sendMail` takes HTML _or_ text, not both, so the Graph transport
  sends the HTML and not the plain-text alternative (`text` is still required by the contract; SMTP
  sends both). Sending MIME instead would carry both and is the documented way if a product needs it.
- Microsoft Graph, Exchange Online limits apply per mailbox: ~30 messages a minute, 10 000 recipients
  and 2 000 external recipients a day. Never send marketing or newsletters through M365.
- Bounce and non-delivery handling: reports land in the product mailbox. Out of scope (later ADR).
- Only the `graph` and `smtp` transports exist.
