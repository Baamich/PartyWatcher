import { ObjectId } from 'mongodb'
import {
  Entity,
  ObjectIdColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm'

export enum SupportTicketStatus {
  UNREAD = 'unread',
  ACCEPTED = 'accepted',
  TRIVIAL = 'trivial',
}

@Entity('supporttickets')
export class SupportTicketEntity {
  @ObjectIdColumn()
  _id: ObjectId

  @Column()
  name: string = ''

  @Column()
  email: string = ''

  @Column()
  description: string

  @Column({ type: 'enum', enum: SupportTicketStatus })
  status: SupportTicketStatus = SupportTicketStatus.UNREAD

  @Column({ nullable: true, default: null })
  userId: ObjectId | null = null

  @Column()
  username: string = ''

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}
