import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Algorithm } from 'jsonwebtoken';
import { JWT_STRATEGY_OPTIONS, type JwtStrategyOptions } from './jwt-options';
import type { JwtPayload } from './jwt-payload';

/**
 * Passport JWT strategy (name: `jwt`). Verifies the Bearer access token against
 * the product's ES256 public key, issuer and audience. The denylist check runs
 * in {@link JwtAuthGuard}, not here.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(@Inject(JWT_STRATEGY_OPTIONS) options: JwtStrategyOptions) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: options.publicKey,
      algorithms: (options.algorithms ?? ['ES256']) as Algorithm[],
      issuer: options.issuer,
      audience: options.audience,
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    // Returning payload attaches it to request.user
    return payload;
  }
}
