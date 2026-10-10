import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { InjectRepository } from '@nestjs/typeorm'
import bcrypt from 'bcrypt'
import { MongoServerError, ObjectId } from 'mongodb'
import { MongoRepository } from 'typeorm'

import { UserEntity } from '../database/entities/user.entity.js'
import { BCRYPT_SALT_ROUNDS } from '../shared/constants.js'
import {
  AuthProfile,
  AuthUser,
} from '../shared/interfaces/auth-user.interface.js'
import { SignupBodyDto } from './dto/signup-body.dto.js'

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: MongoRepository<UserEntity>,
    private readonly jwtService: JwtService,
  ) {}

  public async register(dto: SignupBodyDto): Promise<AuthUser> {
    const usernameLower = dto.username.toLowerCase()

    const existing = await this.userRepository.findOne({
      where: { $or: [{ usernameLower }, { email: dto.email }] },
    })

    if (existing) {
      throw new ConflictException(
        existing.usernameLower === usernameLower
          ? 'This login is already taken'
          : 'This email is already registered',
      )
    }

    const user = this.userRepository.create({
      username: dto.username,
      email: dto.email,
      passwordHash: await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS),
    })

    try {
      return this.toAuthUser(await this.userRepository.save(user))
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new ConflictException('Login or email is already taken')
      }

      throw error
    }
  }

  public async validateUser(
    login: string,
    password: string,
  ): Promise<AuthUser | null> {
    const loginLower = login.trim().toLowerCase()

    const user = await this.userRepository.findOne({
      where: { $or: [{ usernameLower: loginLower }, { email: loginLower }] },
    })

    if (!user) {
      return null
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash)

    return isPasswordValid ? this.toAuthUser(user) : null
  }

  public async getProfile(id: string): Promise<AuthProfile> {
    const user = await this.userRepository.findOne({
      where: { _id: new ObjectId(id) },
      select: { username: true, role: true, streamerName: true },
    })

    if (!user) {
      throw new UnauthorizedException('User not found')
    }

    return {
      ...this.toAuthUser(user),
      streamerName: user.streamerName || null,
    }
  }

  public signToken({ id, username, role }: AuthUser): string {
    return this.jwtService.sign<AuthUser>({ id, username, role })
  }

  private toAuthUser(user: UserEntity): AuthUser {
    return {
      id: user._id.toHexString(),
      username: user.username,
      role: user.role,
    }
  }
}
