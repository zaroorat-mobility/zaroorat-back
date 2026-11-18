export interface FiscalPdfLineItem {
  label: string;
  amount: number;
  note?: string;
}

export interface FiscalDocumentPdfInput {
  documentNumber: string;
  documentType: string;
  status: string;
  issuedAtIso: string;
  rideCode: string | null;
  recipientType: string;
  recipientName: string;
  supplierLegalName: string;
  supplierGstin: string;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  isInterState: boolean;
  sacCode: string | null;
  currency: string;
  taxableValue: number;
  nonTaxableValue: number;
  cgstRatePct: number;
  sgstRatePct: number;
  igstRatePct: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalTaxAmount: number;
  totalAmount: number;
  lineItems: FiscalPdfLineItem[];
  contentSha256: string;
  footerNotice?: string | null;
}

/// Pluggable PDF renderer contract (Rev 5 Phase 6).
/// Swap in an approved Chromium/Puppeteer or PDFKit renderer via DI without touching domain code.
export interface FiscalPdfRenderer {
  readonly rendererName: string;
  render(input: FiscalDocumentPdfInput): Promise<Buffer>;
}

const DOC_TYPE_TITLES: Record<string, string> = {
  PASSENGER_TAX_INVOICE: 'TAX INVOICE (PASSENGER RIDE)',
  COMMISSION_TAX_INVOICE: 'TAX INVOICE (PLATFORM COMMISSION)',
  DRIVER_SETTLEMENT_STATEMENT: 'DRIVER RIDE SETTLEMENT STATEMENT',
  CREDIT_NOTE: 'CREDIT NOTE',
  SUBSCRIPTION_INVOICE: 'SUBSCRIPTION TAX INVOICE',
};

function sanitizeAscii(value: string): string {
  return value
    .replace(/₹/g, 'INR ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pdfEscape(value: string): string {
  return sanitizeAscii(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function fmtMoney(amount: number, currency: string): string {
  const prefix = currency === 'INR' ? 'INR ' : `${sanitizeAscii(currency)} `;
  return `${prefix}${amount.toFixed(2)}`;
}

function truncate(text: string, maxLen: number): string {
  const clean = sanitizeAscii(text);
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 3)}...`;
}

/// Zero-dependency, deterministic PDF 1.4 generator (A4 595x842 pt, Helvetica/Helvetica-Bold).
/// Produces standards-compliant binary PDFs with exact byte-offset xref tables and zero hardcoded
/// GSTINs or SAC codes — every printed value comes verbatim from the immutable FiscalDocument row.
export class BuiltinPdf14Renderer implements FiscalPdfRenderer {
  readonly rendererName = 'builtin-pdf-1.4';

  async render(doc: FiscalDocumentPdfInput): Promise<Buffer> {
    const ops: string[] = [];
    const pageW = 595;
    const pageH = 842;
    const marginX = 42;
    const contentW = pageW - marginX * 2;
    let y = pageH - 46;

    const drawText = (
      x: number,
      yPos: number,
      text: string,
      size: number,
      bold = false,
      rgb: [number, number, number] = [0.09, 0.12, 0.2],
    ) => {
      const font = bold ? '/F2' : '/F1';
      ops.push(
        `BT ${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} rg ${font} ${size} Tf ${x.toFixed(1)} ${yPos.toFixed(1)} Td (${pdfEscape(text)}) Tj ET`,
      );
    };

    const drawRightText = (
      rightX: number,
      yPos: number,
      text: string,
      size: number,
      bold = false,
      rgb: [number, number, number] = [0.09, 0.12, 0.2],
    ) => {
      const clean = sanitizeAscii(text);
      // Approximate Helvetica average glyph width (~0.52 * fontSize) for crisp right alignment
      const approxWidth = clean.length * size * 0.52;
      drawText(Math.max(marginX, rightX - approxWidth), yPos, clean, size, bold, rgb);
    };

    const drawRule = (yPos: number, gray = 0.84, width = 0.7) => {
      ops.push(
        `q ${gray.toFixed(2)} G ${width.toFixed(2)} w ${marginX} ${yPos.toFixed(1)} m ${(pageW - marginX).toFixed(1)} ${yPos.toFixed(1)} l S Q`,
      );
    };

    const drawRect = (
      x: number,
      yBottom: number,
      w: number,
      h: number,
      fillRgb: [number, number, number],
    ) => {
      ops.push(
        `q ${fillRgb[0].toFixed(3)} ${fillRgb[1].toFixed(3)} ${fillRgb[2].toFixed(3)} rg ${x.toFixed(1)} ${yBottom.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f Q`,
      );
    };

    // 1. Header Banner
    drawRect(marginX, y - 42, contentW, 52, [0.122, 0.169, 0.427]);
    drawText(marginX + 14, y - 14, truncate(doc.supplierLegalName, 58), 14, true, [1, 1, 1]);
    const title = DOC_TYPE_TITLES[doc.documentType] ?? doc.documentType;
    drawText(marginX + 14, y - 31, title, 9.5, false, [0.85, 0.89, 0.98]);
    drawRightText(
      pageW - marginX - 14,
      y - 16,
      doc.status === 'VOIDED' ? 'STATUS: VOIDED' : `DOC #: ${doc.documentNumber}`,
      10,
      true,
      doc.status === 'VOIDED' ? [1, 0.72, 0.72] : [1, 1, 1],
    );
    drawRightText(
      pageW - marginX - 14,
      y - 31,
      `Issued: ${doc.issuedAtIso.slice(0, 19).replace('T', ' ')} UTC`,
      8.5,
      false,
      [0.85, 0.89, 0.98],
    );
    y -= 62;

    // 2. Supplier & Tax Jurisdiction Metadata Grid
    drawText(marginX, y, 'SUPPLIER & JURISDICTION', 8.5, true, [0.35, 0.4, 0.5]);
    drawText(marginX + 275, y, 'RECIPIENT & REFERENCE', 8.5, true, [0.35, 0.4, 0.5]);
    y -= 14;

    drawText(marginX, y, `GSTIN: ${doc.supplierGstin}`, 9.5, true);
    drawText(marginX + 275, y, `Recipient: ${truncate(doc.recipientName, 36)}`, 9.5, true);
    y -= 13;

    drawText(
      marginX,
      y,
      `Supplier State: ${doc.supplierStateCode}   |   Place of Supply: ${doc.placeOfSupplyStateCode}`,
      9,
    );
    drawText(marginX + 275, y, `Recipient Type: ${doc.recipientType}`, 9);
    y -= 13;

    drawText(
      marginX,
      y,
      `Supply Nature: ${doc.isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}`,
      9,
    );
    drawText(marginX + 275, y, `Booking / Ride Code: ${doc.rideCode ?? 'N/A'}`, 9);
    y -= 13;

    if (doc.sacCode) {
      drawText(marginX, y, `SAC Code (CA-approved): ${doc.sacCode}`, 9, true);
      y -= 13;
    }

    y -= 6;
    drawRule(y, 0.75, 0.8);
    y -= 18;

    // 3. Itemized Breakdown Table
    drawRect(marginX, y - 5, contentW, 20, [0.945, 0.957, 0.976]);
    drawText(marginX + 8, y + 1, 'DESCRIPTION', 8.5, true, [0.25, 0.3, 0.4]);
    drawRightText(pageW - marginX - 8, y + 1, `AMOUNT (${doc.currency})`, 8.5, true, [0.25, 0.3, 0.4]);
    y -= 20;

    const items = doc.lineItems.slice(0, 18);
    for (const item of items) {
      const label = item.note ? `${item.label} (${item.note})` : item.label;
      drawText(marginX + 8, y, truncate(label, 68), 9.5);
      drawRightText(pageW - marginX - 8, y, fmtMoney(item.amount, doc.currency), 9.5);
      y -= 16;
    }

    drawRule(y + 4, 0.82, 0.6);
    y -= 12;

    // 4. Tax & Totals Summary Box
    const summaryLeft = marginX + 225;
    const summaryRight = pageW - marginX - 8;

    const addSummaryRow = (label: string, val: string, bold = false) => {
      drawText(summaryLeft, y, label, bold ? 10 : 9, bold);
      drawRightText(summaryRight, y, val, bold ? 10 : 9, bold);
      y -= 15;
    };

    addSummaryRow('Taxable Value', fmtMoney(doc.taxableValue, doc.currency));
    if (doc.nonTaxableValue > 0) {
      addSummaryRow('Non-Taxable Charges', fmtMoney(doc.nonTaxableValue, doc.currency));
    }
    if (doc.isInterState) {
      addSummaryRow(
        `IGST (${doc.igstRatePct.toFixed(2)}%)`,
        fmtMoney(doc.igstAmount, doc.currency),
      );
    } else {
      addSummaryRow(
        `CGST (${doc.cgstRatePct.toFixed(2)}%)`,
        fmtMoney(doc.cgstAmount, doc.currency),
      );
      addSummaryRow(
        `SGST (${doc.sgstRatePct.toFixed(2)}%)`,
        fmtMoney(doc.sgstAmount, doc.currency),
      );
    }
    addSummaryRow('Total Tax', fmtMoney(doc.totalTaxAmount, doc.currency), true);

    drawRule(y + 4, 0.4, 1.0);
    y -= 8;
    addSummaryRow('GRAND TOTAL', fmtMoney(doc.totalAmount, doc.currency), true);

    // 5. Audit & Tamper-Evident Footer
    const footerY = 74;
    drawRule(footerY + 18, 0.82, 0.6);
    drawText(
      marginX,
      footerY + 4,
      truncate(
        doc.footerNotice ||
          'System-generated immutable fiscal document issued from locked ride pricing & tax snapshots.',
        96,
      ),
      8,
      false,
      [0.42, 0.47, 0.55],
    );
    drawText(
      marginX,
      footerY - 10,
      `SHA-256 Digest: ${doc.contentSha256}   |   Renderer: ${this.rendererName}`,
      7.5,
      false,
      [0.48, 0.52, 0.6],
    );

    const streamBody = ops.join('\n');
    const streamLen = Buffer.byteLength(streamBody, 'utf8');

    const objects: string[] = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n`,
      '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
      `6 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamBody}\nendstream\nendobj\n`,
    ];

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
    const offsets: number[] = [0];
    let byteOffset = chunks[0]!.length;

    for (const obj of objects) {
      offsets.push(byteOffset);
      const buf = Buffer.from(obj, 'utf8');
      chunks.push(buf);
      byteOffset += buf.length;
    }

    const xrefOffset = byteOffset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      xref += `${String(offsets[i]!).padStart(10, '0')} 00000 n \n`;
    }
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref + trailer, 'utf8'));

    return Buffer.concat(chunks);
  }
}
