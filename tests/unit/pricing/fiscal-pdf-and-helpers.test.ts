import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BuiltinPdf14Renderer,
  computeDocumentSha256,
  escapeCsvCell,
  getIndianFinancialYear,
  validateCompliancePlaceholders,
} from '../../../src/modules/pricing/index.js';

describe('Phase 6 — Fiscal PDF Renderer & Helpers (unit)', () => {
  it('generates a valid PDF 1.4 binary without any hardcoded SAC 9964', async () => {
    const renderer = new BuiltinPdf14Renderer();
    const sha = computeDocumentSha256({ documentNumber: 'ZRT-JK-2627-000001', totalAmount: 165.8 });
    const buf = await renderer.render({
      documentNumber: 'ZRT-JK-2627-000001',
      documentType: 'PASSENGER_TAX_INVOICE',
      status: 'ISSUED',
      issuedAtIso: '2026-11-18T10:00:00.000Z',
      rideCode: 'ZRT-1001',
      recipientType: 'RIDER',
      recipientName: 'Aamir Khan',
      supplierLegalName: 'Zaroorat Mobility Private Limited',
      supplierGstin: '01ABCDE1234F1Z5',
      supplierStateCode: '01',
      placeOfSupplyStateCode: '01',
      isInterState: false,
      sacCode: null,
      currency: 'INR',
      taxableValue: 156.0,
      nonTaxableValue: 2.0,
      cgstRatePct: 2.5,
      sgstRatePct: 2.5,
      igstRatePct: 0,
      cgstAmount: 3.9,
      sgstAmount: 3.9,
      igstAmount: 0,
      totalTaxAmount: 7.8,
      totalAmount: 165.8,
      lineItems: [
        { label: 'Base Fare', amount: 30 },
        { label: 'Distance Fare', amount: 80 },
        { label: 'Time Fare', amount: 20 },
        { label: 'Surge Adjustment', amount: 26 },
        { label: 'Waiting Charges', amount: 2 },
      ],
      contentSha256: sha,
    });

    const text = buf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4\n'), 'Must start with PDF 1.4 header');
    assert.ok(text.includes('xref\n0 7\n'), 'Must contain valid xref table');
    assert.ok(text.includes('startxref\n'), 'Must contain startxref');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'Must end with %%EOF');
    assert.ok(text.includes('ZRT-JK-2627-000001'), 'Must contain document number');
    assert.ok(text.includes('01ABCDE1234F1Z5'), 'Must contain supplier GSTIN');
    assert.ok(text.includes(sha), 'Must contain SHA-256 digest');
    assert.ok(!text.includes('9964'), 'Must NEVER fabricate SAC 9964 when sacCode is null');
  });

  it('computes Indian Financial Year across March 31 / April 1 IST boundaries', () => {
    // 2026-03-31 18:20 UTC = 2026-03-31 23:50 IST -> FY 2025-26
    assert.equal(getIndianFinancialYear(new Date('2026-03-31T18:20:00.000Z')), '2025-26');
    // 2026-03-31 18:35 UTC = 2026-04-01 00:05 IST -> FY 2026-27
    assert.equal(getIndianFinancialYear(new Date('2026-03-31T18:35:00.000Z')), '2026-27');
    assert.equal(getIndianFinancialYear(new Date('2026-11-18T06:00:00.000Z')), '2026-27');
  });

  it('escapes RFC-4180 CSV cells and neutralizes spreadsheet formula injection', () => {
    assert.equal(escapeCsvCell('normal text'), 'normal text');
    assert.equal(escapeCsvCell('a, "b"'), '"a, ""b"""');
    assert.equal(escapeCsvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
    assert.equal(escapeCsvCell('+1+2'), "'+1+2");
    assert.equal(escapeCsvCell('-cmd'), "'-cmd");
    assert.equal(escapeCsvCell('@SUM(A1)'), "'@SUM(A1)");
  });

  it('validates CR-03 compliance template placeholders strictly', () => {
    assert.deepEqual(
      validateCompliancePlaceholders(
        '<h1>{{company_legal_name}}</h1><p>{{invoice_number}} {{sac_code}} {{total_amount}}</p>',
      ),
      [],
    );
    assert.deepEqual(
      validateCompliancePlaceholders('<p>{{invoice_number}} {{not_allowed_token}}</p>'),
      ['not_allowed_token'],
    );
  });
});
