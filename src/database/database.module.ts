import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'

import { EnvParam } from '../shared/enums/env.enum.js'
import { ChatMessageEntity } from './entities/chat-message.entity.js'
import { RoomEntity } from './entities/room.entity.js'
import { SupportTicketEntity } from './entities/support-ticket.entity.js'
import { UserEntity } from './entities/user.entity.js'
import { VideoEntity } from './entities/video.entity.js'

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        type: 'mongodb',
        url: config.getOrThrow<string>(EnvParam.MONGO_URI),
        autoLoadEntities: true,
        synchronize: false,
        logging: true,
        useUnifiedTopology: true,
        entities: [
          ChatMessageEntity,
          RoomEntity,
          SupportTicketEntity,
          UserEntity,
          VideoEntity,
        ],
      }),
    }),
    TypeOrmModule.forFeature([
      ChatMessageEntity,
      RoomEntity,
      SupportTicketEntity,
      UserEntity,
      VideoEntity,
    ]),
  ],
})
export class DatabaseModule {}
