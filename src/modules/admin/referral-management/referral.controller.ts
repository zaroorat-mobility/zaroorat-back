import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminReferralProgramService } from './program/program.service.js';
import { AdminReferralCodeService } from './code/code.service.js';
import { AdminReferralHistoryService } from './history/history.service.js';
import {
  createMilestoneBodySchema,
  createProgramBodySchema,
  idParamSchema,
  listCodesQuerySchema,
  listProgramsQuerySchema,
  listReferralsQuerySchema,
  updateMilestoneBodySchema,
  updateProgramBodySchema,
} from './schemas.js';

export class AdminReferralController {
  constructor(
    private readonly adminReferralProgramService: AdminReferralProgramService,
    private readonly adminReferralCodeService: AdminReferralCodeService,
    private readonly adminReferralHistoryService: AdminReferralHistoryService,
  ) {}

  async listPrograms(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listProgramsQuerySchema.parse(req.query);
    reply.send(await this.adminReferralProgramService.list(query));
  }

  async getProgram(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralProgramService.getById(id) });
  }

  async createProgram(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createProgramBodySchema.parse(req.body);
    reply.status(201).send({ data: await this.adminReferralProgramService.create(body) });
  }

  async updateProgram(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = updateProgramBodySchema.parse(req.body ?? {});
    reply.send({ data: await this.adminReferralProgramService.update(id, body) });
  }

  async activateProgram(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralProgramService.activate(id) });
  }

  async deactivateProgram(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralProgramService.deactivate(id) });
  }

  async addMilestone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = createMilestoneBodySchema.parse(req.body);
    reply.status(201).send({ data: await this.adminReferralProgramService.addMilestone(id, body) });
  }

  async updateMilestone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = updateMilestoneBodySchema.parse(req.body ?? {});
    reply.send({ data: await this.adminReferralProgramService.updateMilestone(id, body) });
  }

  async deactivateMilestone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralProgramService.deactivateMilestone(id) });
  }

  async activateMilestone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralProgramService.activateMilestone(id) });
  }

  async listCodes(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listCodesQuerySchema.parse(req.query);
    reply.send(await this.adminReferralCodeService.list(query));
  }

  async activateCode(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralCodeService.activate(id) });
  }

  async deactivateCode(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralCodeService.deactivate(id) });
  }

  async listReferrals(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listReferralsQuerySchema.parse(req.query);
    reply.send(await this.adminReferralHistoryService.list(query));
  }

  async getReferral(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminReferralHistoryService.getById(id) });
  }
}
