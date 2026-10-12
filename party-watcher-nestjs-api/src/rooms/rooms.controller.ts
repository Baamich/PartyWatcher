import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import { ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger'

import { CurrentUser } from '../auth/decorators/current-user.decorator.js'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js'
import { ErrorResponseDto } from '../shared/dto/error-response.dto.js'
import type { AuthUser } from '../shared/interfaces/auth-user.interface.js'
import { CreateRoomBodyDto } from './dto/create-room-body.dto.js'
import { RoomsService } from './rooms.service.js'

@UseGuards(JwtAuthGuard)
@ApiTags('rooms')
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post()
  createRoom(@CurrentUser() user: AuthUser, @Body() dto: CreateRoomBodyDto) {
    return this.roomsService.createRoom(user, dto)
  }
}
