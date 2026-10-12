import { Injectable, UnauthorizedException } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {
  public handleRequest<TUser>(error: unknown, user: TUser | false): TUser {
    if (error) {
      throw error
    }

    if (!user) {
      throw new UnauthorizedException('Invalid login or password')
    }

    return user
  }
}
