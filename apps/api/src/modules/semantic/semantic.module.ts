import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SemanticModelService } from './semantic-model.service';
import { SemanticPolicyController } from './semantic-policy.controller';
import { SemanticPolicyService } from './semantic-policy.service';
import { SemanticValidationService } from './semantic-validation.service';
import { SemanticController } from './semantic.controller';

@Module({
  imports: [AuditModule],
  controllers: [SemanticController, SemanticPolicyController],
  providers: [SemanticModelService, SemanticValidationService, SemanticPolicyService],
  exports: [SemanticModelService],
})
export class SemanticModule {}
