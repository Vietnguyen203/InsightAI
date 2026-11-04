import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SemanticModelService } from './semantic-model.service';
import { SemanticValidationService } from './semantic-validation.service';
import { SemanticController } from './semantic.controller';

@Module({
  imports: [AuditModule],
  controllers: [SemanticController],
  providers: [SemanticModelService, SemanticValidationService],
  exports: [SemanticModelService],
})
export class SemanticModule {}
