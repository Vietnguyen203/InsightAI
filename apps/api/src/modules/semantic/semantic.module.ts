import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { QueryEngineModule } from '../query-engine/query-engine.module';
import { SemanticMetricController } from './semantic-metric.controller';
import { SemanticMetricService } from './semantic-metric.service';
import { SemanticModelService } from './semantic-model.service';
import { SemanticPolicyController } from './semantic-policy.controller';
import { SemanticPolicyService } from './semantic-policy.service';
import { SemanticValidationService } from './semantic-validation.service';
import { SemanticController } from './semantic.controller';

@Module({
  imports: [AuditModule, QueryEngineModule],
  controllers: [SemanticController, SemanticPolicyController, SemanticMetricController],
  providers: [
    SemanticModelService,
    SemanticValidationService,
    SemanticPolicyService,
    SemanticMetricService,
  ],
  exports: [SemanticModelService, SemanticMetricService],
})
export class SemanticModule {}
