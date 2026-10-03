import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import type { Observable } from 'rxjs'

@Injectable()
export class NoCacheInterceptor implements NestInterceptor {
  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    context
      .switchToHttp()
      .getResponse<FastifyReply>()
      .header('Cache-Control', 'no-store, must-revalidate')

    return next.handle()
  }
}
