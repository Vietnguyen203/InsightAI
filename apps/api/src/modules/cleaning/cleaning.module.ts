import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CleaningSuggestionService } from './cleaning-suggestion.service';
import { CleaningController } from './cleaning.controller';
import { CleaningService } from './cleaning.service';

@Module({
  imports: [AuditModule],
  controllers: [CleaningController],
  providers: [CleaningService, CleaningSuggestionService],
})
export class CleaningModule {}
