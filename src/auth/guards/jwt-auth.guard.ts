import { Injectable, UnauthorizedException } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  public handleRequest<TUser>(
    error: unknown,
    user: TUser | false,
    info?: Error,
  ): TUser {
    if (error) {
      throw error
    }

    if (!user) {
      throw new UnauthorizedException(
        info?.message === 'No auth token' ? 'Not authorized' : 'Invalid token',
      )
    }

    return user
  }
}
