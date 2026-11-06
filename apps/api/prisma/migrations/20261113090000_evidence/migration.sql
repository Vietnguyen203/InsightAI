-- Phase 6E: evidence, hypotheses and findings of investigations (D-53).
-- CreateEnum
CREATE TYPE "HypothesisStatus" AS ENUM ('SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE', 'UNTESTED');

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "investigation_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "queries" JSONB NOT NULL,
    "query_history_ids" UUID[],
    "versions" JSONB NOT NULL,
    "policies_applied" TEXT[],
    "results" JSONB NOT NULL,
    "values" JSONB NOT NULL,
    "limitations" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hypotheses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "investigation_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "status" "HypothesisStatus" NOT NULL,
    "rule" JSONB NOT NULL,
    "evidence_ids" UUID[],
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hypotheses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "investigation_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "evidence_ids" UUID[],
    "verified" BOOLEAN NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL,
    "limitations" TEXT[],

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_investigation_id_idx" ON "evidence"("investigation_id");

-- CreateIndex
CREATE UNIQUE INDEX "hypotheses_investigation_id_key_key" ON "hypotheses"("investigation_id", "key");

-- CreateIndex
CREATE INDEX "findings_investigation_id_position_idx" ON "findings"("investigation_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_steps_organization_id_id_key" ON "investigation_steps"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_investigation_id_fkey" FOREIGN KEY ("organization_id", "investigation_id") REFERENCES "investigations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_step_id_fkey" FOREIGN KEY ("organization_id", "step_id") REFERENCES "investigation_steps"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_organization_id_investigation_id_fkey" FOREIGN KEY ("organization_id", "investigation_id") REFERENCES "investigations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_organization_id_investigation_id_fkey" FOREIGN KEY ("organization_id", "investigation_id") REFERENCES "investigations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Visible exactly when their investigation is (organization + author, see investigations RLS).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence', 'hypotheses', 'findings']
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

-- Evidence is never edited: it leaves only together with its investigation.
DO $$
DECLARE app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'app' AND table_name = 'quality_rules' AND privilege_type = 'INSERT'
      AND grantee <> current_user
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON app.evidence FROM %I', app_role);
  END LOOP;
END $$;
