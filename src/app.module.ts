import path from 'node:path'

import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ServeStaticModule } from '@nestjs/serve-static'

import { AppController } from './app.controller.js'
import { AppService } from './app.service.js'
import { ConfigValidationService } from './config/config-validation.service.js'
import { DatabaseModule } from './database/database.module.js'
import { EventsModule } from './events/events.module.js'
import { LoggerModule } from './logger/logger.module.js'
import { EnvParam } from './shared/enums/env.enum.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: ConfigValidationService.getValidationSchema(),
      validationOptions: {
        libraryOptions: {
          allowUnknown: false,
          abortEarly: true,
        },
      },
    }),
    ServeStaticModule.forRootAsync({
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
        },
        {
          rootPath: config.get<string>(EnvParam.THUMB_DIR),
          serveRoot: '/media/thumbnails',
        },
        {
          rootPath: config.get<string>(EnvParam.YT_CACHE_DIR),
          serveRoot: '/media/yt-cache',
        },
        {
          rootPath: path.join(process.cwd(), 'debug-screenshots'),
          serveRoot: '/debug-screenshots',
        },
      ],
    }),
    EventsModule,
    LoggerModule,
    DatabaseModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
