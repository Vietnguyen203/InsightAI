import { Global, Module } from '@nestjs/common';
import { DataPlaneService } from './data-plane.service';

@Global()
@Module({
  providers: [DataPlaneService],
  exports: [DataPlaneService],
})
export class DataPlaneModule {}
