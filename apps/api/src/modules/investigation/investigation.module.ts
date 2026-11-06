import { Module } from '@nestjs/common';
import { InvestigationCoreModule } from './investigation-core.module';
import { InvestigationController } from './investigation.controller';
import { InvestigationService } from './investigation.service';

/** AI Data Analyst API (docs/PHASE6_AI_ANALYST_DESIGN.md). */
@Module({
  imports: [InvestigationCoreModule],
  controllers: [InvestigationController],
  providers: [InvestigationService],
  exports: [InvestigationCoreModule],
})
export class InvestigationModule {}
