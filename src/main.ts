import fastifyCookie from '@fastify/cookie'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'

import { AppModule } from './app.module.js'
import { EnvParam } from './shared/enums/env.enum.js'
import { LoggerScope } from './shared/enums/logger-scope.enum.js'
import { formatedlogscope } from './shared/helpers/utils.js'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  )

  const config = app.get<ConfigService>(ConfigService)
  const logger = app.get<Logger>(Logger)
  const PORT = config.getOrThrow<number>(EnvParam.PORT)

  await app.register(fastifyCookie)

  app.useLogger(logger)
  app.enableCors()

  await app.listen(PORT, () => {
    logger.log(`${formatedlogscope(LoggerScope.SERVER)}`)
  })
}
await bootstrap()
