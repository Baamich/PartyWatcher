import { ObjectId } from 'mongodb'
import {
  Entity,
  ObjectIdColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

export enum VideoType {
  YOUTUBE = 'youtube',
  TWITCH = 'twitch',
  VK = 'vk',
  DRIVE = 'drive',
  PLAYER_CAPTURE = 'player_capture',
  DIRECT = 'direct',
}

export class VideoMeta {
  @Column({ type: 'int', array: true, default: [] })
  seasons: number[] = []

  @Column({ type: 'int', nullable: true, default: null })
  currentSeason: number | null = null

  @Column({ type: 'int', nullable: true, default: null })
  currentEpisode: number | null = null

  @Column({ type: 'simple-array', default: [] })
  voices: string[] = []

  @Column({ nullable: true, default: null })
  currentVoice: string | null = null
}

export class Video {
  @Column({ type: 'enum', enum: VideoType })
  type: VideoType

  @Column()
  url: string

  @Column({ nullable: true })
  title?: string

  @Column({ default: false })
  ageRestricted: boolean = false

  @Column(() => VideoMeta)
  meta: VideoMeta = new VideoMeta()

  @Column({ default: false })
  ageConfirmed: boolean = false
}

export class Playback {
  @Column({ default: false })
  isPlaying: boolean = false

  @Column({ type: 'double', default: 0 })
  positionSeconds: number = 0

  @Column()
  updatedAt: Date = new Date()
}

@Entity('rooms')
@Index(['code'], { unique: true })
export class RoomEntity {
  @ObjectIdColumn()
  _id: ObjectId

  @Column()
  name: string

  @Column()
  code: string

  @Column()
  owner: ObjectId

  @Column(() => Video)
  video: Video

  @Column({ default: false })
  isPublic: boolean = false

  @Column({ nullable: true, default: null })
  thumbnailUrl: string | null = null

  @Column(() => Playback)
  playback: Playback = new Playback()

  @Column({ nullable: true, default: null })
  emptySince: Date | null = null

  @Column({ type: 'int', default: 0 })
  viewerCount: number = 0

  @Column(() => Array)
  bannedUsers: ObjectId[] = []

  @CreateDateColumn()
  createdAt: Date
}
