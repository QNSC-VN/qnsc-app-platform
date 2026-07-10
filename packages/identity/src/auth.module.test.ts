import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { EntraTokenVerifier } from './entra-verifier';
import { JwtAuthGuard } from './jwt.guard';
import { PermissionGuard } from './permission.guard';

describe('AuthModule.forRoot', () => {
  it('registers the package collaborators and the controller by default', () => {
    const mod = AuthModule.forRoot();

    expect(mod.module).toBe(AuthModule);
    expect(mod.controllers).toContain(AuthController);
    expect(mod.providers).toEqual(
      expect.arrayContaining([AuthService, EntraTokenVerifier, PermissionGuard]),
    );
    expect(mod.exports).toEqual(
      expect.arrayContaining([AuthService, EntraTokenVerifier, JwtAuthGuard, PermissionGuard]),
    );
  });

  it('threads the product imports and provider bindings through', () => {
    const OPTIONS = Symbol('OPTIONS');
    const optionProvider = { provide: OPTIONS, useValue: { ok: true } };
    class FakeModule {}

    const mod = AuthModule.forRoot({ imports: [FakeModule], providers: [optionProvider] });

    expect(mod.imports).toContain(FakeModule);
    expect(mod.providers).toContain(optionProvider);
  });

  it('omits the controller when controller:false', () => {
    const mod = AuthModule.forRoot({ controller: false });
    expect(mod.controllers).toEqual([]);
  });
});
