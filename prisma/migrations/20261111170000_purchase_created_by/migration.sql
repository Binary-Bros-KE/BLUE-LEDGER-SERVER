-- Who created a purchase now syncs (DESKTOP sends createdBy; the phone app sets it).
ALTER TABLE "purchases" ADD COLUMN "createdBy" TEXT;
