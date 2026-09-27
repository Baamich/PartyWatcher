import fastifyCookie from '@fastify/cookie'
import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { useContainer } from 'class-validator'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module.js'
import { API_PREFIX, AUTH_COOKIE_NAME } from './shared/constants.js'
import { EnvParam } from './shared/enums/env.enum.js'
import { LoggerScope } from './shared/enums/logger-scope.enum.js'
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter.js'
import { formatedlogscope } from './shared/helpers/utils.js'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: 'loopback' }),
  )

  const logger = app.get<Logger>(Logger)
  const config = app.get<ConfigService>(ConfigService)
  const PORT = config.getOrThrow<number>(EnvParam.PORT)

  await app.register(fastifyCookie)

  app.useLogger(logger)
  app.enableCors()
  app.setGlobalPrefix(API_PREFIX)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      stopAtFirstError: true,
      transformOptions: {
        exposeUnsetFields: false,
      },
    }),
  )
  app.useGlobalFilters(new AllExceptionsFilter())

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PartyWatcher API')
      .setVersion('1.0')
      .addCookieAuth(AUTH_COOKIE_NAME)
      .addBearerAuth()
      .build(),
  )
  SwaggerModule.setup('docs', app, document, { useGlobalPrefix: true })

  useContainer(app.select(AppModule), {
    fallback: true,
    fallbackOnErrors: true,
  })

  await app.listen(PORT, () => {
    logger.log(`${formatedlogscope(LoggerScope.SERVER)}`)
  })
}
await bootstrap()
