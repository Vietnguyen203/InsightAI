import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrganizationModule } from '../organization/organization.module';
import { InvitationController } from './invitation.controller';
import { InvitationService } from './invitation.service';
import { MembershipController } from './membership.controller';
import { MembershipService } from './membership.service';
import { TenantGuard } from './tenant.guard';

@Module({
  imports: [AuditModule, OrganizationModule],
  controllers: [MembershipController, InvitationController],
  providers: [MembershipService, InvitationService, TenantGuard],
  exports: [MembershipService, InvitationService, TenantGuard],
})
export class IamModule {}
