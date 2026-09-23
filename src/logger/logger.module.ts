import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino'

import { EnvParam } from '../shared/enums/env.enum.js'

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level:
            config.getOrThrow<string>(EnvParam.NODE_ENV) === 'test'
              ? 'silent'
              : 'info',
          transport:
            config.getOrThrow<string>(EnvParam.NODE_ENV) === 'test'
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                  },
                },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
