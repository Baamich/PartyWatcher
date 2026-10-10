import { UserRole } from '../../shared/enums/user-role.enum.js'
import { AuthUser } from '../../shared/interfaces/auth-user.interface.js'

export class AuthUserResponseDto implements AuthUser {
  id: string
  username: string
  role: UserRole
}
