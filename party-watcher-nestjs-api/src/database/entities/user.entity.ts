import { ObjectId } from 'mongodb'
import {
  Entity,
  ObjectIdColumn,
  Column,
  CreateDateColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm'

import { UserRole } from '../../shared/enums/user-role.enum.js'

@Entity('users')
@Index(['username'], { unique: true })
@Index(['usernameLower'], { unique: true })
@Index(['email'], { unique: true })
@Index(['streamerNameLower'], { unique: true, sparse: true })
@Index(['streamKey'], { unique: true, sparse: true })
@Index(['streamPlaybackId'], { unique: true, sparse: true })
export class UserEntity {
  @ObjectIdColumn()
  _id: ObjectId

  @Column()
  username: string

  @Column()
  usernameLower: string

  @Column()
  email: string

  @Column()
  passwordHash: string

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole = UserRole.USER

  @CreateDateColumn()
  createdAt: Date

  @Column({ nullable: true })
  streamerName?: string

  @Column({ nullable: true })
  streamerNameLower?: string

  @Column({ default: false })
  isLive: boolean = false

  @Column({ nullable: true, default: null })
  liveStartedAt: Date | null = null

  @Column({ default: '' })
  streamerBio: string = ''

  @Column({ nullable: true, default: null })
  streamerAvatarUrl: string | null = null

  @Column({ nullable: true, default: null })
  streamerBannerUrl: string | null = null

  @Column({ type: 'int', default: 0 })
  profileViews: number = 0

  @Column({ default: '' })
  streamTitle: string = ''

  @Column({ default: '' })
  streamDescription: string = ''

  @Column({ nullable: true })
  streamKey?: string

  @Column({ nullable: true })
  streamPlaybackId?: string

  @BeforeInsert()
  @BeforeUpdate()
  syncDerivedFields() {
    if (this.username) {
      this.usernameLower = this.username.toLowerCase()
    }

    if (this.email) {
      this.email = this.email.toLowerCase().trim()
    }

    if (this.streamerName) {
      this.streamerName = this.streamerName.trim()
    }

    this.streamerNameLower = this.streamerName
      ? this.streamerName.toLowerCase()
      : undefined
  }
}
