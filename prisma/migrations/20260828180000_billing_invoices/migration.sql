-- CreateTable
CREATE TABLE "billing_invoices" (
    "id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "ride_id" UUID,
    "recipient_type" TEXT NOT NULL,
    "recipient_user_id" UUID,
    "recipient_name" TEXT NOT NULL,
    "booking_code" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "hsn_code" TEXT NOT NULL DEFAULT '9964',
    "from_route" TEXT,
    "to_route" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "template_type" TEXT NOT NULL DEFAULT 'RIDER_INVOICE',
    "header_logo_text" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "footer_terms" TEXT NOT NULL,
    "cgst_rate" DECIMAL(5,2) NOT NULL DEFAULT 2.5,
    "sgst_rate" DECIMAL(5,2) NOT NULL DEFAULT 2.5,
    "igst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "applies_to" TEXT NOT NULL DEFAULT 'ride',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_invoice_number_key" ON "billing_invoices"("invoice_number");

-- CreateIndex
CREATE INDEX "billing_invoices_recipient_type_idx" ON "billing_invoices"("recipient_type");

-- CreateIndex
CREATE INDEX "billing_invoices_issued_at_idx" ON "billing_invoices"("issued_at");

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;
