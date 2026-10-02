import path from 'node:path'

import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ServeStaticModule } from '@nestjs/serve-static'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'

import { AppController } from './app.controller.js'
import { AppService } from './app.service.js'
import { AuthModule } from './auth/auth.module.js'
import { ConfigValidationService } from './config/config-validation.service.js'
import { DatabaseModule } from './database/database.module.js'
import { EventsModule } from './events/events.module.js'
import { LoggerModule } from './logger/logger.module.js'
import { THROTTLE_LIMIT, THROTTLE_TTL } from './shared/constants.js'
import { EnvParam } from './shared/enums/env.enum.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: ConfigValidationService.getValidationSchema(),
      validationOptions: {
        libraryOptions: {
          allowUnknown: true,
          abortEarly: true,
        },
      },
    }),
    ServeStaticModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          rootPath: path.join(import.meta.dirname, '../..', 'src', 'public'),
        },
        {
          rootPath: path.join(
            process.cwd(),
            config.getOrThrow<string>(EnvParam.UPLOAD_DIR),
          ),
          serveRoot: '/uploads',
          serveStaticOptions: { decorateReply: false },
        },
        {
          rootPath: config.get<string>(EnvParam.THUMB_DIR),
          serveRoot: '/media/thumbnails',
          serveStaticOptions: { decorateReply: false },
        },
        {
          rootPath: config.get<string>(EnvParam.YT_CACHE_DIR),
          serveRoot: '/media/yt-cache',
          serveStaticOptions: { decorateReply: false },
        },
        {
          rootPath: path.join(process.cwd(), 'debug-screenshots'),
          serveRoot: '/debug-screenshots',
          serveStaticOptions: { decorateReply: false },
        },
      ],
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: THROTTLE_TTL, limit: THROTTLE_LIMIT }],
      errorMessage: 'Too many requests',
      skipIf: (context) => context.getType() !== 'http',
    }),
    EventsModule,
    LoggerModule,
    DatabaseModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
