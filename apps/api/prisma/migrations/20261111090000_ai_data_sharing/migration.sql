-- Phase 6B: organization setting for what the external AI provider may receive (D-50).
-- CreateEnum
CREATE TYPE "AiDataSharing" AS ENUM ('METADATA_ONLY', 'FULL');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "ai_data_sharing" "AiDataSharing" NOT NULL DEFAULT 'METADATA_ONLY';

