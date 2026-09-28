-- AlterTable
-- Storefront template + brand-colour overrides (admin-only look & feel). Every existing store keeps
-- rendering exactly as before: "classic" is the only template that existed, and '{}' = its defaults.
ALTER TABLE "web_stores" ADD COLUMN     "templateId" TEXT NOT NULL DEFAULT 'classic',
ADD COLUMN     "themeColorsJson" JSONB NOT NULL DEFAULT '{}';
