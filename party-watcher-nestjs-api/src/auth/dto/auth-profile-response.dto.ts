import { AuthProfile } from '../../shared/interfaces/auth-user.interface.js'
import { AuthUserResponseDto } from './auth-user-response.dto.js'

export class AuthProfileResponseDto
  extends AuthUserResponseDto
  implements AuthProfile
{
  streamerName: string | null
}
