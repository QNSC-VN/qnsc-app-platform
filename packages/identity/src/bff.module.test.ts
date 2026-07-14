import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BffModule } from './bff.module';
import { BffService } from './bff.service';
import { BffSessionStore } from './bff-session.store';
import { EntraOidcClient } from './entra-oidc.client';

describe('BffModule.forRoot', () => {
  it('registers and exports the BFF collaborators', () => {
    const mod = BffModule.forRoot();

    expect(mod.module).toBe(BffModule);
    expect(mod.providers).toEqual(
      expect.arrayContaining([EntraOidcClient, BffSessionStore, BffService]),
    );
    expect(mod.exports).toEqual(
      expect.arrayContaining([BffService, BffSessionStore, EntraOidcClient]),
    );
  });

  it('threads the product imports and provider bindings through', () => {
    const OPTIONS = Symbol('OPTIONS');
    const optionProvider = { provide: OPTIONS, useValue: { ok: true } };
    class FakeModule {}

    const mod = BffModule.forRoot({ imports: [FakeModule], providers: [optionProvider] });

    expect(mod.imports).toContain(FakeModule);
    expect(mod.providers).toContain(optionProvider);
  });
});
