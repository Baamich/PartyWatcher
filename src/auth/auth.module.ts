import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'

import { EnvParam } from '../shared/enums/env.enum.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { JwtStrategy } from './strategies/jwt.strategy.js'
import { LocalStrategy } from './strategies/local.strategy.js'

@Global()
@Module({
  imports: [
    PassportModule.register({}),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(EnvParam.JWT_SECRET),
        signOptions: {
          expiresIn: config.getOrThrow<JwtSignOptions['expiresIn']>(
            EnvParam.JWT_EXPIRES_IN,
          ),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy],
  exports: [PassportModule],
})
export class AuthModule {}
