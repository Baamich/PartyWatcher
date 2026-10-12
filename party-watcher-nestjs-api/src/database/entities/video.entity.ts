import { ObjectId } from 'mongodb'
import { Entity, ObjectIdColumn, Column, CreateDateColumn } from 'typeorm'

@Entity('videos')
export class VideoEntity {
  @ObjectIdColumn()
  _id: ObjectId

  @Column()
  owner: ObjectId

  @Column()
  filename: string

  @Column()
  originalName: string

  @Column()
  sizeBytes: number

  @CreateDateColumn()
  createdAt: Date

  @Column()
  expiresAt: Date
}
