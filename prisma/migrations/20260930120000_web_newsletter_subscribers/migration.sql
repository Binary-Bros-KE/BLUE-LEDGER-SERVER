-- Storefront newsletter sign-ups (the website's "Get the Latest Deals" box). One row per tenant+email.
CREATE TABLE "web_newsletter_subscribers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "web_newsletter_subscribers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "web_newsletter_subscribers_tenantId_email_key" ON "web_newsletter_subscribers"("tenantId", "email");
CREATE INDEX "web_newsletter_subscribers_tenantId_createdAt_idx" ON "web_newsletter_subscribers"("tenantId", "createdAt");

ALTER TABLE "web_newsletter_subscribers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "web_newsletter_subscribers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "web_newsletter_subscribers"
  USING ("tenantId" = current_setting('app.tenant_id', true));
