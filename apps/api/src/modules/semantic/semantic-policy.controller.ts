import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type AccessPolicy,
  accessPolicySchema,
  createAccessPolicyRequestSchema,
  Permission,
  updateAccessPolicyRequestSchema,
} from '@insightai/contracts';
import { z } from 'zod';
import { RequirePermissions } from '../../platform/http/decorators';
import { CurrentTenant, type TenantContext } from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { SemanticPolicyService } from './semantic-policy.service';

/** Access policies are governance: changing them needs `semantic:publish`. */
@ApiTags('semantic')
@Controller()
export class SemanticPolicyController {
  constructor(private readonly policies: SemanticPolicyService) {}

  @Get('semantic-models/:modelId/access-policies')
  @RequirePermissions(Permission.SEMANTIC_READ)
  @ApiZodResponse(200, z.array(accessPolicySchema))
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
  ): Promise<AccessPolicy[]> {
    return this.policies.list(ctx, modelId);
  }

  @Post('semantic-models/:modelId/access-policies')
  @RequirePermissions(Permission.SEMANTIC_PUBLISH)
  @ApiZodBody(createAccessPolicyRequestSchema)
  @ApiZodResponse(201, accessPolicySchema)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body(zod(createAccessPolicyRequestSchema))
    body: z.output<typeof createAccessPolicyRequestSchema>,
  ): Promise<AccessPolicy> {
    return this.policies.create(ctx, modelId, body);
  }

  @Patch('semantic-access-policies/:policyId')
  @RequirePermissions(Permission.SEMANTIC_PUBLISH)
  @ApiZodBody(updateAccessPolicyRequestSchema)
  @ApiZodResponse(200, accessPolicySchema)
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body(zod(updateAccessPolicyRequestSchema))
    body: z.output<typeof updateAccessPolicyRequestSchema>,
  ): Promise<AccessPolicy> {
    return this.policies.update(ctx, policyId, body);
  }

  @Delete('semantic-access-policies/:policyId')
  @HttpCode(204)
  @RequirePermissions(Permission.SEMANTIC_PUBLISH)
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('policyId', ParseUUIDPipe) policyId: string,
  ): Promise<void> {
    return this.policies.remove(ctx, policyId);
  }
}
