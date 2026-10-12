import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  ValidateNested,
} from 'class-validator'

import { VideoType } from '../../shared/enums/video-type.enum.js'

export class CreateRoomBodyDto {
  @IsString()
  @IsNotEmpty()
  name: string

  @IsObject()
  @IsNotEmpty()
  @ValidateNested()
  video: VideoDto

  @IsBoolean()
  @IsOptional()
  isPublic: boolean

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(5)
  roomCodeReties?: number
}

export class VideoDto {
  @IsString()
  @IsEnum(VideoType)
  @IsNotEmpty()
  type: VideoType

  @IsString()
  @IsUrl()
  @IsNotEmpty()
  url: string
}
