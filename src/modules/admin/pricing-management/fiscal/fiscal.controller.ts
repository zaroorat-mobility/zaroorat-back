import type { FastifyReply, FastifyRequest } from 'fastify';
import { auditActor } from '../../audit/index.js';
import { AdminFiscalDocumentService } from './fiscal.service.js';
import {
  createComplianceTemplateBodySchema,
  createDocumentSeriesBodySchema,
  exportFiscalDocumentsQuerySchema,
  fiscalDocIdParamSchema,
  fiscalDocumentTypeSchema,
  listFiscalDocumentsQuerySchema,
  voidFiscalDocumentBodySchema,
} from './fiscal.schemas.js';

export class AdminFiscalDocumentController {
  constructor(private readonly adminFiscalDocumentService: AdminFiscalDocumentService) {}

  async listDocuments(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listFiscalDocumentsQuerySchema.parse(req.query);
    const result = await this.adminFiscalDocumentService.listDocuments(query);
    reply.send(result);
  }

  async getDocumentById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fiscalDocIdParamSchema.parse(req.params);
    const data = await this.adminFiscalDocumentService.getDocumentById(id);
    reply.send({ data });
  }

  async createSignedDownloadUrl(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fiscalDocIdParamSchema.parse(req.params);
    const data = await this.adminFiscalDocumentService.createSignedDownloadUrl(id, auditActor(req));
    reply.send({ data });
  }

  async streamPdf(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fiscalDocIdParamSchema.parse(req.params);
    const { buffer, fileName } = await this.adminFiscalDocumentService.renderPdfBuffer(id);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(buffer);
  }

  async exportCsv(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = exportFiscalDocumentsQuerySchema.parse(req.query);
    const { csv, fileName, rowCount } = await this.adminFiscalDocumentService.exportCsv(
      query,
      auditActor(req),
    );
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('X-Export-Row-Count', String(rowCount))
      .header('Cache-Control', 'private, no-store')
      .send(csv);
  }

  async voidDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fiscalDocIdParamSchema.parse(req.params);
    const body = voidFiscalDocumentBodySchema.parse(req.body);
    const data = await this.adminFiscalDocumentService.voidDocument(id, body, auditActor(req));
    reply.send({ data });
  }

  async listDocumentSeries(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminFiscalDocumentService.listDocumentSeries();
    reply.send({ data });
  }

  async createDocumentSeries(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createDocumentSeriesBodySchema.parse(req.body);
    const data = await this.adminFiscalDocumentService.createDocumentSeries(body, auditActor(req));
    reply.status(201).send({ data });
  }

  async listComplianceTemplates(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rawType = (req.query as Record<string, unknown> | undefined)?.documentType;
    const docType = rawType ? fiscalDocumentTypeSchema.parse(rawType) : undefined;
    const data = await this.adminFiscalDocumentService.listComplianceTemplates(docType);
    reply.send({ data });
  }

  async createComplianceTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createComplianceTemplateBodySchema.parse(req.body);
    const data = await this.adminFiscalDocumentService.createComplianceTemplate(
      body,
      auditActor(req),
    );
    reply.status(201).send({ data });
  }

  async approveComplianceTemplatePreview(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fiscalDocIdParamSchema.parse(req.params);
    const data = await this.adminFiscalDocumentService.approveComplianceTemplatePreview(
      id,
      auditActor(req),
    );
    reply.send({ data });
  }

  async activateComplianceTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fiscalDocIdParamSchema.parse(req.params);
    const data = await this.adminFiscalDocumentService.activateComplianceTemplate(
      id,
      auditActor(req),
    );
    reply.send({ data });
  }
}
