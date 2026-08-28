import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminInvoiceService } from './invoice.service.js';
import {
  createInvoiceTemplateBodySchema,
  invoiceIdParamSchema,
  invoiceTemplateIdParamSchema,
  listInvoicesQuerySchema,
  updateInvoiceTemplateBodySchema,
} from './invoice.schemas.js';

export class AdminInvoiceController {
  constructor(private readonly adminInvoiceService: AdminInvoiceService) {}

  async listInvoices(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listInvoicesQuerySchema.parse(req.query);
    const result = await this.adminInvoiceService.listInvoices(query);
    reply.send(result);
  }

  async getInvoiceById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = invoiceIdParamSchema.parse(req.params);
    const data = await this.adminInvoiceService.getInvoiceById(id);
    reply.send({ data });
  }

  async listTemplates(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminInvoiceService.listTemplates();
    reply.send({ data });
  }

  async createTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createInvoiceTemplateBodySchema.parse(req.body);
    const data = await this.adminInvoiceService.createTemplate(body);
    reply.status(201).send({ data });
  }

  async updateTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = invoiceTemplateIdParamSchema.parse(req.params);
    const body = updateInvoiceTemplateBodySchema.parse(req.body ?? {});
    const data = await this.adminInvoiceService.updateTemplate(id, body);
    reply.send({ data });
  }

  async deleteTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = invoiceTemplateIdParamSchema.parse(req.params);
    await this.adminInvoiceService.deleteTemplate(id);
    reply.send({ success: true });
  }

  async setDefaultTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = invoiceTemplateIdParamSchema.parse(req.params);
    const data = await this.adminInvoiceService.setDefaultTemplate(id);
    reply.send({ data });
  }
}
