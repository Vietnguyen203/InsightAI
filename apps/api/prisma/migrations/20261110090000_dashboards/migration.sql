-- Phase 6a: dashboards and widgets.
-- CreateEnum
CREATE TYPE "DashboardVisibility" AS ENUM ('PRIVATE', 'ORG');

-- CreateTable
CREATE TABLE "dashboards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "DashboardVisibility" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "semantic_query" JSONB NOT NULL,
    "chart_spec" JSONB NOT NULL,
    "position" JSONB NOT NULL,
    "source_message_id" UUID,
    "saved_model_revision" INTEGER NOT NULL,
    "saved_metric_versions" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dashboards_organization_id_updated_at_idx" ON "dashboards"("organization_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dashboards_organization_id_id_key" ON "dashboards"("organization_id", "id");

-- CreateIndex
CREATE INDEX "dashboard_widgets_dashboard_id_idx" ON "dashboard_widgets"("dashboard_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_widgets_organization_id_id_key" ON "dashboard_widgets"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_organization_id_dashboard_id_fkey" FOREIGN KEY ("organization_id", "dashboard_id") REFERENCES "dashboards"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation + visibility: PRIVATE dashboards exist only for their owner (app.user_id).
-- Who may edit an ORG dashboard of someone else (organization owner/admin) is checked in the service.
ALTER TABLE app.dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dashboards FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboards_visible ON app.dashboards
  USING (
    organization_id = app.ctx_uuid('app.org_id')
    AND (visibility = 'ORG' OR owner_id = app.ctx_uuid('app.user_id'))
  )
  WITH CHECK (
    organization_id = app.ctx_uuid('app.org_id')
    AND (visibility = 'ORG' OR owner_id = app.ctx_uuid('app.user_id'))
  );
CREATE POLICY dashboards_insert_own ON app.dashboards AS RESTRICTIVE FOR INSERT
  WITH CHECK (owner_id = app.ctx_uuid('app.user_id'));

-- Widgets are visible exactly when their dashboard is (the subquery is subject to RLS too).
ALTER TABLE app.dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dashboard_widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY widgets_visible ON app.dashboard_widgets
  USING (
    organization_id = app.ctx_uuid('app.org_id')
    AND EXISTS (SELECT 1 FROM app.dashboards d WHERE d.id = dashboard_id)
  )
  WITH CHECK (
    organization_id = app.ctx_uuid('app.org_id')
    AND EXISTS (SELECT 1 FROM app.dashboards d WHERE d.id = dashboard_id)
  );
