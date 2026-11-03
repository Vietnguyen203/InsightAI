import { Global, Module } from '@nestjs/common';
import { DataPlaneService } from './data-plane.service';
import { TenantProvisioningService } from './tenant-provisioning.service';

@Global()
@Module({
  providers: [DataPlaneService, TenantProvisioningService],
  exports: [DataPlaneService, TenantProvisioningService],
})
export class DataPlaneModule {}
