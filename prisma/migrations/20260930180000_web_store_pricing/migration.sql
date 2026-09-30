-- Website price markup (src/lib/web-pricing.ts): { markupPercent, roundTo }, '{}' = no markup.
ALTER TABLE "web_stores" ADD COLUMN "pricingJson" JSONB NOT NULL DEFAULT '{}';
