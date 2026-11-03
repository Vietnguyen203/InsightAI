import { Module } from '@nestjs/common';
import { QualityCoreModule } from './quality-core.module';
import { QualityController } from './quality.controller';

@Module({
  imports: [QualityCoreModule],
  controllers: [QualityController],
})
export class QualityModule {}
