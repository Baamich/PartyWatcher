import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply } from 'fastify'

import {
  AUTH_COOKIE_MAX_AGE,
  AUTH_COOKIE_NAME,
  AUTH_THROTTLE_LIMIT,
  THROTTLE_TTL,
} from '../shared/constants.js'
import { ErrorResponseDto } from '../shared/dto/error-response.dto.js'
import { StatusResponseDto } from '../shared/dto/status-response.dto.js'
import { EnvParam } from '../shared/enums/env.enum.js'
import type {
  AuthProfile,
  AuthUser,
} from '../shared/interfaces/auth-user.interface.js'
import { AuthService } from './auth.service.js'
import { CurrentUser } from './decorators/current-user.decorator.js'
import { AuthProfileResponseDto } from './dto/auth-profile-response.dto.js'
import { AuthUserResponseDto } from './dto/auth-user-response.dto.js'
import { LoginBodyDto } from './dto/login-body.dto.js'
import { SignupBodyDto } from './dto/signup-body.dto.js'
import { JwtAuthGuard } from './guards/jwt-auth.guard.js'
import { LocalAuthGuard } from './guards/local-auth.guard.js'

@ApiTags('auth')
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Controller('auth')
export class AuthController {
  private readonly cookieDomain: string | undefined
  private readonly secureCookie: boolean

  constructor(
    private readonly authService: AuthService,
    config: ConfigService,
  ) {
    this.cookieDomain =
      config.getOrThrow<string>(EnvParam.COOKIE_DOMAIN) || undefined
    this.secureCookie =
      config.getOrThrow<string>(EnvParam.PUBLIC_URL).startsWith('https://') ||
      config.getOrThrow<boolean>(EnvParam.FORCE_SECURE_COOKIE)
  }

  @Post('register')
  @Throttle({ default: { ttl: THROTTLE_TTL, limit: AUTH_THROTTLE_LIMIT } })
  @ApiCreatedResponse({ type: AuthUserResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  public async register(
    @Body() dto: SignupBodyDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthUser> {
    const user = await this.authService.register(dto)

    this.setTokenCookie(reply, this.authService.signToken(user))

    return user
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: THROTTLE_TTL, limit: AUTH_THROTTLE_LIMIT } })
  @UseGuards(LocalAuthGuard)
  @ApiBody({ type: LoginBodyDto })
  @ApiOkResponse({ type: AuthUserResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  public login(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): AuthUser {
    this.setTokenCookie(reply, this.authService.signToken(user))

    return user
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: StatusResponseDto })
  public logout(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.clearCookie(AUTH_COOKIE_NAME, {
      domain: this.cookieDomain,
      path: '/',
    })

    return { status: 'ok' }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiBearerAuth()
  @ApiOkResponse({ type: AuthProfileResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  public me(@CurrentUser() user: AuthUser): Promise<AuthProfile> {
    return this.authService.getProfile(user.id)
  }

  private setTokenCookie(reply: FastifyReply, token: string) {
    reply.setCookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.secureCookie,
      sameSite: 'lax',
      domain: this.cookieDomain,
      maxAge: AUTH_COOKIE_MAX_AGE,
      path: '/',
    })
  }
}
