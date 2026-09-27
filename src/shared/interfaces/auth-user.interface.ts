import { UserRole } from '../enums/user-role.enum.js'

export interface AuthUser {
  id: string
  username: string
  role: UserRole
}

export interface AuthProfile extends AuthUser {
  streamerName: string | null
}
