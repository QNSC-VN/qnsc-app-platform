import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@qnsc-vn/platform-cache';
import type { BffAuthRequest, BffSession } from './bff.types';

const SESSION_KEY_PREFIX = 'bff:sess:';
const AUTH_REQUEST_KEY_PREFIX = 'bff:authreq:';

/** OIDC round-trip window: authorize → Entra login → callback. */
const AUTH_REQUEST_TTL_SECONDS = 10 * 60;

/**
 * Thin, storage-only persistence for BFF sessions and pending auth requests,
 * backed by the shared {@link CacheService} (Valkey). It owns key naming and
 * TTLs but no auth policy — orchestration (OIDC exchange, token rotation) lives
 * in {@link BffService}. Keeping this a pure store is what lets each product
 * adopt the mechanism while wiring its own Valkey instance.
 */
@Injectable()
export class BffSessionStore {
  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  async saveAuthRequest(request: BffAuthRequest): Promise<void> {
    await this.cache.setJson(
      AUTH_REQUEST_KEY_PREFIX + request.state,
      request,
      AUTH_REQUEST_TTL_SECONDS,
    );
  }

  /**
   * Fetch and immediately delete the pending auth request for `state`. Single-use
   * by construction: a replayed callback finds nothing and is rejected.
   */
  async takeAuthRequest(state: string): Promise<BffAuthRequest | null> {
    const key = AUTH_REQUEST_KEY_PREFIX + state;
    const request = await this.cache.getJson<BffAuthRequest>(key);
    if (request) {
      await this.cache.del(key);
    }
    return request;
  }

  async saveSession(sid: string, session: BffSession, ttlSeconds: number): Promise<void> {
    await this.cache.setJson(SESSION_KEY_PREFIX + sid, session, ttlSeconds);
  }

  async getSession(sid: string): Promise<BffSession | null> {
    return this.cache.getJson<BffSession>(SESSION_KEY_PREFIX + sid);
  }

  async deleteSession(sid: string): Promise<void> {
    await this.cache.del(SESSION_KEY_PREFIX + sid);
  }
}
