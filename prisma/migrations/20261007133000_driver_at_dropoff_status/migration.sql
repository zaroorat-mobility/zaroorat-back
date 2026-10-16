-- AlterEnum
ALTER TYPE "RideStatus" ADD VALUE 'DRIVER_AT_DROPOFF';

-- AlterTable
ALTER TABLE "rides" ADD COLUMN "dropoff_arrived_at" TIMESTAMP(3);
