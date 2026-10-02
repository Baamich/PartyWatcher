import { ExecutionContext, createParamDecorator } from '@nestjs/common'

import { AuthUser } from '../../shared/interfaces/auth-user.interface.js'

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest<{ user: AuthUser }>().user,
)
