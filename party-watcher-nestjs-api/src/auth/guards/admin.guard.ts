import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { ObjectId } from 'mongodb'
import { MongoRepository } from 'typeorm'

import { UserEntity } from '../../database/entities/user.entity.js'
import { UserRole } from '../../shared/enums/user-role.enum.js'
import { AuthUser } from '../../shared/interfaces/auth-user.interface.js'

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: MongoRepository<UserEntity>,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>()

    if (!user?.id || !ObjectId.isValid(user.id)) {
      throw new ForbiddenException('Admin only')
    }

    const dbUser = await this.userRepository.findOne({
      where: { _id: new ObjectId(user.id) },
      select: { role: true },
    })

    if (dbUser?.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin only')
    }

    return true
  }
}
