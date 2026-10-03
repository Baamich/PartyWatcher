import { ObjectId } from 'mongodb'
import {
  Entity,
  ObjectIdColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

@Entity('chatmessages')
@Index(['room', 'createdAt'])
export class ChatMessageEntity {
  @ObjectIdColumn()
  _id: ObjectId

  @Column()
  room: ObjectId

  @Column()
  username: string

  @Column()
  text: string

  @CreateDateColumn()
  createdAt: Date
}
