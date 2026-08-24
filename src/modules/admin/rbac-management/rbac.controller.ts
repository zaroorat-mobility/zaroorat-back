import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminRbacService } from './rbac.service.js';
import {
  createRoleBodySchema,
  rbacRoleSlugParamSchema,
  replaceRolePermissionsBodySchema,
} from './rbac.schemas.js';

export class AdminRbacController {
  constructor(private readonly adminRbacService: AdminRbacService) {}

  async listPermissions(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminRbacService.listPermissions();
    reply.send({ data });
  }

  async listRoles(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminRbacService.listRoles();
    reply.send({ data });
  }

  async createRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createRoleBodySchema.parse(req.body);
    const data = await this.adminRbacService.createRole(body);
    reply.code(201).send({ data });
  }

  async replaceRolePermissions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { slug } = rbacRoleSlugParamSchema.parse(req.params);
    const body = replaceRolePermissionsBodySchema.parse(req.body);
    const data = await this.adminRbacService.replaceRolePermissions(slug, body.permissionCodes);
    reply.send({ data });
  }
}
