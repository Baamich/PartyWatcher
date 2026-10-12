import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  public catch(exception: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>()
    reply.header('Cache-Control', 'no-store, must-revalidate')

    if (!(exception instanceof HttpException)) {
      this.logger.error(exception)

      return reply
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send({ error: 'Internal server error' })
    }

    const response = exception.getResponse()
    const error =
      typeof response === 'object' &&
      'message' in response &&
      Array.isArray(response.message)
        ? response.message[0]
        : exception.message

    return reply.status(exception.getStatus()).send({ error })
  }
}
