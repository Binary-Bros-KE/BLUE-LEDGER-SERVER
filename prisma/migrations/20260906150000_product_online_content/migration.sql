-- Rich web-only product content for the storefront detail page (see ECOMMERCE-ARCHITECTURE.md).
-- { quickSpecs: string[], blocks: [{ type: "paragraph"|"specs"|"notes", heading?, body?, items? }] }
-- Synced from the desktop like the other online_* fields (it's just JSON).

ALTER TABLE "products" ADD COLUMN "onlineContentJson" JSONB NOT NULL DEFAULT '{}';
