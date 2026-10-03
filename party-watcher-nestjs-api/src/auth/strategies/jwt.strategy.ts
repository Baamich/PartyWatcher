import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import type { FastifyRequest } from 'fastify'
import { ExtractJwt, Strategy } from 'passport-jwt'

import { AUTH_COOKIE_NAME } from '../../shared/constants.js'
import { EnvParam } from '../../shared/enums/env.enum.js'
import { AuthUser } from '../../shared/interfaces/auth-user.interface.js'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: FastifyRequest) => req.cookies?.[AUTH_COOKIE_NAME] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>(EnvParam.JWT_SECRET),
    })
  }

  public validate({ id, username, role }: AuthUser): AuthUser {
    return { id, username, role }
  }
}
