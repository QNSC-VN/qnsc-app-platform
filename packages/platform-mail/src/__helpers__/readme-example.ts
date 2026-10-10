import { Inject, Injectable, Module } from '@nestjs/common';
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import { JobsModule } from '@quynhonsemiconductor/platform-jobs/nest';
import { createValkeyMailState, type EmailMessage } from '@quynhonsemiconductor/platform-mail';
import { MailModule, MailService } from '@quynhonsemiconductor/platform-mail/nest';

@Injectable()
export class SignUp {
  constructor(@Inject(MailService) private readonly mail: MailService) {}

  async register(message: EmailMessage, tx: DbExecutor) {
    await this.mail.enqueue(message, { tx }); // rolled back with the transaction: no user, no email
  }
}

@Module({
  imports: [
    JobsModule.forRoot(),
    CacheModule.forRoot({ url: process.env['REDIS_URL'], mode: 'required' }),
    MailModule.forRootAsync({
      inject: [CacheService],
      // CacheService connects in onModuleInit, which Nest runs AFTER it has built every provider,
      // this factory included: `cache.instance` is still null here. Look it up on first use.
      useFactory: (cache: CacheService) => ({
        state: createValkeyMailState({ eval: (...args) => cache.instance.eval(...args) }),
      }),
    }),
  ],
  providers: [SignUp],
})
export class AppModule {}
