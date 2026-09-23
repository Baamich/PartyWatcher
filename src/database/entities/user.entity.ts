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

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

@Entity('users')
@Index(['username'], { unique: true })
@Index(['usernameLower'], { unique: true })
@Index(['email'], { unique: true })
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

  @BeforeInsert()
  @BeforeUpdate()
  syncDerivedFields() {
    if (this.username) {
      this.usernameLower = this.username.toLowerCase()
    }
    if (this.email) {
      this.email = this.email.toLowerCase().trim()
    }
  }
}
