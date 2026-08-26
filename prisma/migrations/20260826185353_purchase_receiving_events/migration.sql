-- AlterTable
ALTER TABLE "purchases" ADD COLUMN "receivingEvents" JSONB NOT NULL DEFAULT '[]';
