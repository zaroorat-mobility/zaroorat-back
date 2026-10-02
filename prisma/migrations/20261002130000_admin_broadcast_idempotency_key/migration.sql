-- Push schedule idempotency. A client-supplied Idempotency-Key is stored on the
-- broadcast it created, unique per creator, so a retried or concurrent duplicate
-- submission resolves to the one row inside the same transaction as its audit row.
-- NULL keys (requests without the header) never collide.
ALTER TABLE "admin_broadcasts" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "admin_broadcasts_created_by_idempotency_key_key"
  ON "admin_broadcasts"("created_by", "idempotency_key");
