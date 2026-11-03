import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DataPlaneModule } from './data-plane/data-plane.module';
import { LoggerModule } from './logger/logger.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';

/** Infrastructure shared by the api and worker processes. */
@Module({
  imports: [ConfigModule, LoggerModule, PrismaModule, DataPlaneModule, QueueModule, StorageModule],
})
export class PlatformModule {}
