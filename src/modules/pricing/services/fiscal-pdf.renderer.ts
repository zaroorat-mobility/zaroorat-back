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
  supplierAddress?: string | null;
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
  taxNote?: string | null;
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
  WALLET_RECHARGE_RECEIPT: 'COMMISSION WALLET RECHARGE RECEIPT',
  DRIVER_SETTLEMENT_STATEMENT: 'DRIVER RIDE SETTLEMENT STATEMENT',
  CREDIT_NOTE: 'GST CREDIT NOTE',
  SUBSCRIPTION_INVOICE: 'SUBSCRIPTION TAX INVOICE',
};

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitsToWords(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o > 0 ? `${TENS[t]} ${ONES[o]}` : (TENS[t] ?? '');
}

function threeDigitsToWords(n: number): string {
  const h = Math.floor(n / 100);
  const rem = n % 100;
  if (h > 0 && rem > 0) return `${ONES[h]} Hundred ${twoDigitsToWords(rem)}`;
  if (h > 0) return `${ONES[h]} Hundred`;
  return twoDigitsToWords(rem);
}

function intToIndianWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crores = Math.floor(n / 10_000_000);
  const remAfterCrore = n % 10_000_000;
  const lakhs = Math.floor(remAfterCrore / 100_000);
  const remAfterLakh = remAfterCrore % 100_000;
  const thousands = Math.floor(remAfterLakh / 1_000);
  const hundreds = remAfterLakh % 1_000;

  if (crores > 0) parts.push(`${intToIndianWords(crores)} Crore`);
  if (lakhs > 0) parts.push(`${twoDigitsToWords(lakhs)} Lakh`);
  if (thousands > 0) parts.push(`${twoDigitsToWords(thousands)} Thousand`);
  if (hundreds > 0) parts.push(threeDigitsToWords(hundreds));
  return parts.join(' ').trim();
}

export function amountToIndianWords(amount: number): string {
  const abs = Math.abs(Math.round(amount * 100) / 100);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  const rupeePart = `Rupees ${intToIndianWords(rupees)}`;
  if (paise > 0) {
    return `${rupeePart} and ${twoDigitsToWords(paise)} Paise Only`;
  }
  return `${rupeePart} Only`;
}

function formatIstDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return sanitizeAscii(iso);
  const istMs = d.getTime() + 330 * 60_000;
  const ist = new Date(istMs);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const day = String(ist.getUTCDate()).padStart(2, '0');
  const mon = months[ist.getUTCMonth()] ?? 'Jan';
  const year = ist.getUTCFullYear();
  let hours = ist.getUTCHours();
  const mins = String(ist.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${day} ${mon} ${year}, ${String(hours).padStart(2, '0')}:${mins} ${ampm} IST`;
}

function sanitizeAscii(value: string): string {
  return value
    .replace(/₹/g, 'INR ')
    .replace(/→/g, '->')
    .replace(/–|—/g, '-')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pdfEscape(value: string): string {
  return sanitizeAscii(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function fmtMoney(amount: number, currency: string): string {
  const prefix = currency === 'INR' ? 'INR ' : `${sanitizeAscii(currency)} `;
  const sign = amount < 0 ? '-' : '';
  return `${sign}${prefix}${Math.abs(amount).toFixed(2)}`;
}

function truncate(text: string, maxLen: number): string {
  const clean = sanitizeAscii(text);
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 3)}...`;
}

function wrapText(text: string, maxChars: number, maxLines = 3): string[] {
  const words = sanitizeAscii(text).split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxChars) {
      current = `${current} ${w}`;
    } else {
      lines.push(current);
      current = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(truncate(current, maxChars));
  }
  return lines;
}

/// Executive Zaroorat-Theme Zero-Dependency PDF 1.4 Generator (A4 595x842 pt).
/// Uses Zaroorat Navy (#1F2B6D), Emerald Accent (#10B981), clean bordered cards,
/// IST timestamps, Indian Rupees-in-words, and tamper-evident SHA-256 footer.
export class BuiltinPdf14Renderer implements FiscalPdfRenderer {
  readonly rendererName = 'zaroorat-pdf-1.4-v2';

  async render(doc: FiscalDocumentPdfInput): Promise<Buffer> {
    const ops: string[] = [];
    const pageW = 595;
    const pageH = 842;
    const marginX = 38;
    const contentW = pageW - marginX * 2;

    // Zaroorat Theme Palette (RGB 0..1)
    const NAVY: [number, number, number] = [0.122, 0.169, 0.427]; // #1F2B6D
    const EMERALD: [number, number, number] = [0.063, 0.725, 0.506]; // #10B981
    const ROSE: [number, number, number] = [0.882, 0.114, 0.282]; // #E11D48
    const SLATE_900: [number, number, number] = [0.059, 0.09, 0.165];
    const SLATE_600: [number, number, number] = [0.278, 0.333, 0.412];
    const SLATE_400: [number, number, number] = [0.58, 0.639, 0.722];
    const CARD_BG: [number, number, number] = [0.973, 0.98, 0.988]; // #F8FAFC
    const BORDER: [number, number, number] = [0.855, 0.886, 0.925]; // #DAE2EC
    const SOFT_BLUE_BG: [number, number, number] = [0.937, 0.957, 1.0]; // #EFF4FF

    const drawText = (
      x: number,
      yPos: number,
      text: string,
      size: number,
      bold = false,
      rgb: [number, number, number] = SLATE_900,
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
      rgb: [number, number, number] = SLATE_900,
    ) => {
      const clean = sanitizeAscii(text);
      const factor = bold ? 0.545 : 0.51;
      const approxWidth = clean.length * size * factor;
      drawText(Math.max(marginX, rightX - approxWidth), yPos, clean, size, bold, rgb);
    };

    const drawRect = (
      x: number,
      yBottom: number,
      w: number,
      h: number,
      fillRgb?: [number, number, number],
      strokeRgb?: [number, number, number],
      lineWidth = 0.7,
    ) => {
      const cmds: string[] = ['q'];
      if (fillRgb) {
        cmds.push(`${fillRgb[0].toFixed(3)} ${fillRgb[1].toFixed(3)} ${fillRgb[2].toFixed(3)} rg`);
      }
      if (strokeRgb) {
        cmds.push(
          `${strokeRgb[0].toFixed(3)} ${strokeRgb[1].toFixed(3)} ${strokeRgb[2].toFixed(3)} RG ${lineWidth.toFixed(2)} w`,
        );
      }
      const paintOp = fillRgb && strokeRgb ? 'B' : fillRgb ? 'f' : 'S';
      cmds.push(
        `${x.toFixed(1)} ${yBottom.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re ${paintOp} Q`,
      );
      ops.push(cmds.join(' '));
    };

    const drawRule = (x1: number, x2: number, yPos: number, rgb = BORDER, width = 0.7) => {
      ops.push(
        `q ${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} RG ${width.toFixed(2)} w ${x1.toFixed(1)} ${yPos.toFixed(1)} m ${x2.toFixed(1)} ${yPos.toFixed(1)} l S Q`,
      );
    };

    const isWalletRecharge = doc.documentType === 'WALLET_RECHARGE_RECEIPT';
    const isVoided = doc.status === 'VOIDED';
    const docTitle = DOC_TYPE_TITLES[doc.documentType] ?? doc.documentType.replace(/_/g, ' ');

    // ─── 1. Executive Zaroorat Brand Header ───────────────────────────────────
    const headerTop = pageH - 34;
    const headerH = 78;
    const headerBottom = headerTop - headerH;

    // Top emerald accent bar + Navy hero banner
    drawRect(marginX, headerTop - 4, contentW, 4, isVoided ? ROSE : EMERALD);
    drawRect(marginX, headerBottom, contentW, headerH - 4, NAVY);

    // Left: ZAROORAT wordmark + Legal Entity + Document Title
    drawText(marginX + 16, headerTop - 24, 'ZAROORAT', 15, true, [1, 1, 1]);
    drawText(
      marginX + 16,
      headerTop - 41,
      truncate(doc.supplierLegalName, 48),
      10,
      true,
      [0.86, 0.91, 1],
    );
    drawText(marginX + 16, headerTop - 56, truncate(docTitle, 52), 8.5, false, [0.74, 0.82, 0.96]);

    // Right: Status Pill + Document Number + IST Timestamp
    const badgeW = isVoided ? 62 : 66;
    const badgeX = pageW - marginX - 16 - badgeW;
    drawRect(badgeX, headerTop - 28, badgeW, 15, isVoided ? ROSE : EMERALD);
    drawText(
      badgeX + (isVoided ? 12 : 14),
      headerTop - 23.5,
      isVoided ? 'VOIDED' : isWalletRecharge ? 'CREDITED' : 'ISSUED',
      8,
      true,
      [1, 1, 1],
    );

    drawRightText(
      pageW - marginX - 16,
      headerTop - 44,
      `${isWalletRecharge ? 'RECEIPT #' : 'INVOICE #'}: ${doc.documentNumber}`,
      9.5,
      true,
      [1, 1, 1],
    );
    drawRightText(
      pageW - marginX - 16,
      headerTop - 59,
      formatIstDateTime(doc.issuedAtIso),
      8,
      false,
      [0.78, 0.85, 0.97],
    );

    // ─── 2. Two-Column Bordered Info Cards (Supplier & Recipient) ─────────────
    const cardGap = 12;
    const cardW = (contentW - cardGap) / 2;
    const cardH = 104;
    const cardTop = headerBottom - 14;
    const cardBottom = cardTop - cardH;

    // Left Card: Supplier & Jurisdiction
    drawRect(marginX, cardBottom, cardW, cardH, CARD_BG, BORDER, 0.8);
    drawText(marginX + 12, cardTop - 15, 'SUPPLIER & TAX JURISDICTION', 7.8, true, NAVY);
    drawRule(marginX + 12, marginX + cardW - 12, cardTop - 20, BORDER, 0.5);

    let ly = cardTop - 33;
    drawText(marginX + 12, ly, truncate(doc.supplierLegalName, 40), 9.2, true, SLATE_900);
    ly -= 12.5;
    drawText(marginX + 12, ly, `GSTIN: ${doc.supplierGstin}`, 8.5, true, SLATE_900);
    ly -= 12;
    if (doc.supplierAddress) {
      drawText(marginX + 12, ly, truncate(doc.supplierAddress, 44), 7.8, false, SLATE_600);
      ly -= 11.5;
    }
    drawText(
      marginX + 12,
      ly,
      `State: ${doc.supplierStateCode}  |  Place of Supply: ${doc.placeOfSupplyStateCode}`,
      8,
      false,
      SLATE_600,
    );
    ly -= 11.5;
    drawText(
      marginX + 12,
      ly,
      isWalletRecharge
        ? 'Tax Nature: Prepaid Deposit (0% GST at Top-Up)'
        : `Supply: ${doc.isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}`,
      8,
      false,
      SLATE_600,
    );
    ly -= 11.5;
    if (doc.sacCode) {
      drawText(marginX + 12, ly, `SAC Code: ${doc.sacCode}`, 8.2, true, NAVY);
    }

    // Right Card: Recipient & Reference
    const rx = marginX + cardW + cardGap;
    drawRect(rx, cardBottom, cardW, cardH, CARD_BG, BORDER, 0.8);
    drawText(rx + 12, cardTop - 15, 'BILLED TO & REFERENCE', 7.8, true, NAVY);
    drawRule(rx + 12, rx + cardW - 12, cardTop - 20, BORDER, 0.5);

    let ry = cardTop - 33;
    drawText(rx + 12, ry, truncate(doc.recipientName, 40), 9.5, true, SLATE_900);
    ry -= 13;
    drawText(
      rx + 12,
      ry,
      `Account Type: ${doc.recipientType === 'DRIVER' ? 'Driver Partner' : 'Rider (Customer)'}`,
      8.3,
      false,
      SLATE_600,
    );
    ry -= 12.5;
    drawText(
      rx + 12,
      ry,
      `${isWalletRecharge ? 'Payment Ref' : 'Ride / Booking Ref'}: ${doc.rideCode ?? 'N/A'}`,
      8.3,
      false,
      SLATE_600,
    );
    ry -= 12.5;
    drawText(rx + 12, ry, `Currency: ${doc.currency || 'INR'}`, 8.3, false, SLATE_600);
    ry -= 12.5;
    drawText(rx + 12, ry, `Document Status: ${doc.status}`, 8.3, true, isVoided ? ROSE : EMERALD);

    // ─── 3. Executive Line-Items Table (Zaroorat Navy Header + Zebra Rows) ────
    let y = cardBottom - 18;
    const tableHeaderH = 22;
    drawRect(marginX, y - tableHeaderH, contentW, tableHeaderH, NAVY);
    drawText(marginX + 12, y - 14, '#', 8.2, true, [1, 1, 1]);
    drawText(marginX + 36, y - 14, 'DESCRIPTION', 8.2, true, [1, 1, 1]);
    drawRightText(
      pageW - marginX - 12,
      y - 14,
      `AMOUNT (${doc.currency || 'INR'})`,
      8.2,
      true,
      [1, 1, 1],
    );
    y -= tableHeaderH;

    const items = doc.lineItems.slice(0, 14);
    const rowH = 22;
    items.forEach((item, idx) => {
      const rowBottom = y - rowH;
      const fill = idx % 2 === 1 ? CARD_BG : ([1, 1, 1] as [number, number, number]);
      drawRect(marginX, rowBottom, contentW, rowH, fill, BORDER, 0.5);

      const label = item.note ? `${item.label} (${item.note})` : item.label;
      drawText(marginX + 12, rowBottom + 7.5, String(idx + 1), 8.5, false, SLATE_600);
      drawText(marginX + 36, rowBottom + 7.5, truncate(label, 66), 9, false, SLATE_900);
      drawRightText(
        pageW - marginX - 12,
        rowBottom + 7.5,
        fmtMoney(item.amount, doc.currency),
        9,
        true,
        SLATE_900,
      );
      y = rowBottom;
    });

    // ─── 4. Bottom 2-Column Settlement Block (Amount in Words + Totals Box) ───
    y -= 16;
    const leftBoxW = 278;
    const rightBoxW = contentW - leftBoxW - 12;
    const rightBoxX = marginX + leftBoxW + 12;

    // Build totals rows first to know exact height
    const summaryRows: Array<{ label: string; value: string; bold?: boolean }> = [];
    if (isWalletRecharge) {
      summaryRows.push({
        label: 'Prepaid Wallet Deposit',
        value: fmtMoney(doc.nonTaxableValue || doc.totalAmount, doc.currency),
      });
      summaryRows.push({
        label: 'GST at Top-Up (0%)',
        value: fmtMoney(0, doc.currency),
      });
    } else {
      summaryRows.push({
        label: 'Taxable Value',
        value: fmtMoney(doc.taxableValue, doc.currency),
      });
      if (doc.nonTaxableValue > 0) {
        summaryRows.push({
          label: 'Non-Taxable Charges',
          value: fmtMoney(doc.nonTaxableValue, doc.currency),
        });
      }
      if (doc.isInterState) {
        summaryRows.push({
          label: `IGST (${doc.igstRatePct.toFixed(2)}%)`,
          value: fmtMoney(doc.igstAmount, doc.currency),
        });
      } else {
        summaryRows.push({
          label: `CGST (${doc.cgstRatePct.toFixed(2)}%)`,
          value: fmtMoney(doc.cgstAmount, doc.currency),
        });
        summaryRows.push({
          label: `SGST (${doc.sgstRatePct.toFixed(2)}%)`,
          value: fmtMoney(doc.sgstAmount, doc.currency),
        });
      }
      summaryRows.push({
        label: 'Total Tax',
        value: fmtMoney(doc.totalTaxAmount, doc.currency),
        bold: true,
      });
    }

    const totalBoxH = summaryRows.length * 17 + 44;
    const boxBottom = y - totalBoxH;

    // Left Box: Amount in Words + Compliance / Deposit Note
    drawRect(marginX, boxBottom, leftBoxW, totalBoxH, SOFT_BLUE_BG, BORDER, 0.8);
    drawText(marginX + 12, y - 16, 'AMOUNT IN WORDS', 7.8, true, NAVY);
    const wordsLines = wrapText(amountToIndianWords(doc.totalAmount), 44, 2);
    let wy = y - 30;
    for (const line of wordsLines) {
      drawText(marginX + 12, wy, line, 8.8, true, SLATE_900);
      wy -= 12;
    }

    const noteText =
      doc.taxNote ||
      (isWalletRecharge
        ? 'Prepaid refundable Commission Wallet deposit. INR 0.00 GST at recharge; platform commission & GST are billed per completed ride.'
        : 'Issued from immutable locked ride pricing & tax snapshot. Computer-generated invoice; no physical signature required.');
    const noteLines = wrapText(noteText, 48, 3);
    wy -= 6;
    for (const line of noteLines) {
      drawText(marginX + 12, wy, line, 7.5, false, SLATE_600);
      wy -= 10.5;
    }

    // Right Box: Tax Summary + Zaroorat Navy Grand Total Bar
    drawRect(rightBoxX, boxBottom, rightBoxW, totalBoxH, CARD_BG, BORDER, 0.8);
    let sy = y - 17;
    for (const row of summaryRows) {
      drawText(
        rightBoxX + 12,
        sy,
        row.label,
        8.5,
        Boolean(row.bold),
        row.bold ? SLATE_900 : SLATE_600,
      );
      drawRightText(rightBoxX + rightBoxW - 12, sy, row.value, 8.5, Boolean(row.bold), SLATE_900);
      sy -= 17;
    }

    // Grand Total Navy Bar at bottom of Right Box
    const grandBarH = 26;
    drawRect(rightBoxX, boxBottom, rightBoxW, grandBarH, NAVY);
    drawText(
      rightBoxX + 12,
      boxBottom + 9,
      isWalletRecharge ? 'AMOUNT CREDITED' : 'GRAND TOTAL',
      9.2,
      true,
      [1, 1, 1],
    );
    drawRightText(
      rightBoxX + rightBoxW - 12,
      boxBottom + 9,
      fmtMoney(doc.totalAmount, doc.currency),
      10.5,
      true,
      [1, 1, 1],
    );

    // ─── 5. Tamper-Evident Executive Footer ───────────────────────────────────
    const footerY = 58;
    drawRule(marginX, pageW - marginX, footerY + 20, BORDER, 0.8);
    drawText(
      marginX,
      footerY + 6,
      truncate(
        doc.footerNotice ||
          'System-generated Zaroorat fiscal document issued from immutable PostgreSQL records.',
        98,
      ),
      7.8,
      false,
      SLATE_600,
    );
    drawText(
      marginX,
      footerY - 7,
      `SHA-256 Verification Digest: ${doc.contentSha256}`,
      7.2,
      false,
      SLATE_400,
    );
    drawRightText(pageW - marginX, footerY - 7, 'Page 1 of 1', 7.5, true, SLATE_600);

    // Build Binary PDF 1.4
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
