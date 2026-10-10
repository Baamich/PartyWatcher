import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { MongoRepository } from 'typeorm'

import { RoomEntity } from '../database/entities/room.entity.js'
import { VideoType } from '../shared/enums/video-type.enum.js'
import { generateHexCode } from '../shared/helpers/utils.js'
import type { AuthUser } from '../shared/interfaces/auth-user.interface.js'
import { CreateRoomBodyDto, VideoDto } from './dto/create-room-body.dto.js'

@Injectable()
export class RoomsService {
  constructor(
    @InjectRepository(RoomEntity)
    private readonly roomRepository: MongoRepository<RoomEntity>,
  ) {}

  async createRoom(
    user: AuthUser,
    { video, roomCodeReties, name, isPublic }: CreateRoomBodyDto,
  ) {
    const { error } = this.validateVideo(video)
    if (error) {
      throw new BadRequestException({ error })
    }

    const code = await this.generateRoomCodeRetriable(roomCodeReties)

    const room = await this.roomRepository.insert({
      name,
      code,
      owner: user.id,
      video,
      isPublic,
    })

    // TODO io operation

    return room
  }

  private async generateRoomCodeRetriable(retries?: number) {
    const MAX_RETRIES = retries ?? 3

    for (let attempts = 0; attempts < MAX_RETRIES; attempts++) {
      const code = generateHexCode()

      const existingRoom = await this.roomRepository.findOne({
        where: { code },
      })

      if (!existingRoom) {
        return code
      }
    }

    throw new ConflictException(
      'Failed to generate a unique room code. Please try again.',
    )
  }

  private validateVideo(video: VideoDto) {
    const { type, url } = video

    const isCorrectUrl = /^https?:\/\//i.test(url)

    if (
      (type === VideoType.DIRECT || type === VideoType.PLAYER_CAPTURE) &&
      !isCorrectUrl
    ) {
      return { error: `Video URL requires protocol (http/https)` }
    }

    return { error: null }
  }
}
