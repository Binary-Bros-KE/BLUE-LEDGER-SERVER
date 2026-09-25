-- AlterTable
-- Mirrors DESKTOP's matching migration. Existing tenants keep invoice editing enabled.
ALTER TABLE "tenants" ADD COLUMN     "invoiceEditsDisabled" BOOLEAN NOT NULL DEFAULT false;
