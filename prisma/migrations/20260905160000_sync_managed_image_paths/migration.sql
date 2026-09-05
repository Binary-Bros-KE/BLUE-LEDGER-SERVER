-- AlterTable
-- Client request: product images, employee photos, and storefront logos are now named after their
-- owning entity's own id (DESKTOP's finalize*Path helpers, image-service.ts) instead of a random
-- filename, so their PATH is now meaningful across devices even though the actual image FILE still
-- never reaches the cloud — this is what makes manually copying the images folder from one device
-- to another actually work: once a device pulls the correct path for a product/employee/location,
-- a locally-present file under that same name resolves immediately, with nothing else to configure.
ALTER TABLE "products" ADD COLUMN "imagePath" TEXT;
ALTER TABLE "employees" ADD COLUMN "photoPath" TEXT;
ALTER TABLE "locations" ADD COLUMN "logoPath" TEXT;
ALTER TABLE "locations" ADD COLUMN "logoRatio" TEXT;
