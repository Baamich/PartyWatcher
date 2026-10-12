import { Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-local'

import { AuthUser } from '../../shared/interfaces/auth-user.interface.js'
import { AuthService } from '../auth.service.js'

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: 'login' })
  }

  public validate(login: string, password: string): Promise<AuthUser | null> {
    return this.authService.validateUser(String(login), String(password))
  }
}
