-- Additive only: preserve all legacy null equipment links and existing facts.
CREATE TABLE "work_order_equipment" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "work_order_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL CHECK (quantity > 0),
  "kind" TEXT NOT NULL CHECK (kind IN ('self-made', 'purchased')),
  UNIQUE (tenant_id, work_order_id, code),
  UNIQUE (tenant_id, work_order_id, name),
  UNIQUE (tenant_id, work_order_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_tenant_id_identity ON work_orders(tenant_id, id);
ALTER TABLE work_order_equipment ADD CONSTRAINT work_order_equipment_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id);
ALTER TABLE listing_lines ADD COLUMN equipment_ref TEXT;
ALTER TABLE listing_lines ADD COLUMN origin TEXT NOT NULL DEFAULT 'production' CHECK (origin IN ('production', 'aftermarket'));
ALTER TABLE listing_lines ADD CONSTRAINT listing_lines_equipment_fk FOREIGN KEY (tenant_id, work_order_id, equipment_ref) REFERENCES work_order_equipment(tenant_id, work_order_id, id);
ALTER TABLE dispatch_orders ADD COLUMN equipment_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(equipment_refs) = 'array');
ALTER TABLE dispatch_orders ADD COLUMN rollup BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE work_order_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_equipment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_order_equipment FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.current_tenant', true)::text) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::text);
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON work_order_equipment TO app_user; END IF; END $$;
