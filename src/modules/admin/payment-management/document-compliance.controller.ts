import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DocumentComplianceService } from './document-compliance.service.js';
import {
  complianceDriverParamSchema,
  documentSettingsBodySchema,
  listDocumentComplianceQuerySchema,
  reviewDocumentBodySchema,
  reviewDocumentParamSchema,
} from './document-compliance.schemas.js';

export class DocumentComplianceController {
  constructor(private readonly documentComplianceService: DocumentComplianceService) {}

  async listCompliance(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listDocumentComplianceQuerySchema.parse(req.query);
    reply.send(await this.documentComplianceService.listCompliance(query));
  }

  async getCompliance(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId } = complianceDriverParamSchema.parse(req.params);
    const alertThresholdDays = req.query
      ? listDocumentComplianceQuerySchema.pick({ alertThresholdDays: true }).parse(req.query)
          .alertThresholdDays
      : undefined;
    reply.send({
      data: await this.documentComplianceService.getCompliance(driverId, alertThresholdDays),
    });
  }

  async getSettings(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send({ data: await this.documentComplianceService.getSettings() });
  }

  async updateSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = documentSettingsBodySchema.parse(req.body);
    reply.send({
      data: await this.documentComplianceService.updateSettings(body, callerId(req)),
    });
  }

  async reviewDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { documentId } = reviewDocumentParamSchema.parse(req.params);
    const body = reviewDocumentBodySchema.parse(req.body);
    reply.send({
      data: await this.documentComplianceService.reviewDocument(
        documentId,
        body.status,
        callerId(req),
        body.rejectionReason,
      ),
    });
  }
}
