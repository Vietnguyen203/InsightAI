-- Phase 6C: investigations, steps and their event log (D-52).
-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('QUEUED', 'PLANNING', 'AWAITING_APPROVAL', 'RUNNING', 'VALIDATING', 'REPORTING', 'COMPLETED', 'PARTIAL', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvestigationStepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "investigations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "semantic_model_id" UUID NOT NULL,
    "goal" TEXT NOT NULL,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'QUEUED',
    "require_approval" BOOLEAN NOT NULL DEFAULT false,
    "plan" JSONB,
    "pinned" JSONB,
    "budget" JSONB NOT NULL,
    "usage" JSONB NOT NULL,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "investigations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation_steps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "investigation_id" UUID NOT NULL,
    "step_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "InvestigationStepStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "query_history_ids" UUID[],
    "error_code" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "investigation_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation_events" (
    "seq" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "investigation_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investigation_events_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "investigations_organization_id_user_id_created_at_idx" ON "investigations"("organization_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "investigations_organization_id_status_idx" ON "investigations"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "investigations_organization_id_id_key" ON "investigations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_steps_investigation_id_step_key_key" ON "investigation_steps"("investigation_id", "step_key");

-- CreateIndex
CREATE INDEX "investigation_events_investigation_id_seq_idx" ON "investigation_events"("investigation_id", "seq");

-- AddForeignKey
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_organization_id_semantic_model_id_fkey" FOREIGN KEY ("organization_id", "semantic_model_id") REFERENCES "semantic_models"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation_steps" ADD CONSTRAINT "investigation_steps_organization_id_investigation_id_fkey" FOREIGN KEY ("organization_id", "investigation_id") REFERENCES "investigations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation_events" ADD CONSTRAINT "investigation_events_organization_id_investigation_id_fkey" FOREIGN KEY ("organization_id", "investigation_id") REFERENCES "investigations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Private to the author: the organization AND the user must match (app.user_id is set by the
-- API and by the worker, which runs every investigation as its author).
ALTER TABLE app.investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.investigations FORCE ROW LEVEL SECURITY;
CREATE POLICY investigations_owner ON app.investigations
  USING (organization_id = app.ctx_uuid('app.org_id') AND user_id = app.ctx_uuid('app.user_id'))
  WITH CHECK (organization_id = app.ctx_uuid('app.org_id') AND user_id = app.ctx_uuid('app.user_id'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['investigation_steps', 'investigation_events']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY via_investigation ON app.%I
         USING (organization_id = app.ctx_uuid(''app.org_id'')
                AND EXISTS (SELECT 1 FROM app.investigations i WHERE i.id = investigation_id))
         WITH CHECK (organization_id = app.ctx_uuid(''app.org_id'')
                AND EXISTS (SELECT 1 FROM app.investigations i WHERE i.id = investigation_id))', t);
  END LOOP;
END $$;

-- The event log is append-only for the application (rows go with their investigation).
DO $$
DECLARE app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'app' AND table_name = 'quality_rules' AND privilege_type = 'INSERT'
      AND grantee <> current_user
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON app.investigation_events FROM %I', app_role);
    EXECUTE format('GRANT USAGE ON SEQUENCE app.investigation_events_seq_seq TO %I', app_role);
  END LOOP;
END $$;
