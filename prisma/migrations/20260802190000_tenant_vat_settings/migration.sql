-- AlterTable
-- Mirrors DESKTOP's matching migration (tenant_vat_settings). Existing tenants all default to
-- Kenya's 16% inclusive VAT — the only regime this app has ever actually run under.
ALTER TABLE "tenants" ADD COLUMN     "vatRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 16;
ALTER TABLE "tenants" ADD COLUMN     "pricesTaxInclusive" BOOLEAN NOT NULL DEFAULT true;
