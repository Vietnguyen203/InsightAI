-- Phase 6F: rendered investigation reports (D-54).
-- CreateTable
CREATE TABLE "investigation_reports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "investigation_id" UUID NOT NULL,
    "lang" TEXT NOT NULL,
    "renderer" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investigation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "investigation_reports_organization_id_investigation_id_key" ON "investigation_reports"("organization_id", "investigation_id");

-- AddForeignKey
ALTER TABLE "investigation_reports" ADD CONSTRAINT "investigation_reports_organization_id_investigation_id_fkey" FOREIGN KEY ("organization_id", "investigation_id") REFERENCES "investigations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Visible exactly when its investigation is (organization + author, see investigations RLS).
ALTER TABLE app.investigation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.investigation_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY via_investigation ON app.investigation_reports
  USING (organization_id = app.ctx_uuid('app.org_id')
         AND EXISTS (SELECT 1 FROM app.investigations i WHERE i.id = investigation_id))
  WITH CHECK (organization_id = app.ctx_uuid('app.org_id')
         AND EXISTS (SELECT 1 FROM app.investigations i WHERE i.id = investigation_id));
