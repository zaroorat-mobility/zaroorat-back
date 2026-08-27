import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { ReferralApplyService } from './referral-apply.service.js';
import { ReferralCodeService } from './referral-code.service.js';
import { applyReferralBodySchema } from './schemas.js';
import { ReferralError } from './referral.errors.js';

type Audience = 'RIDER' | 'DRIVER';

export class ReferralController {
  constructor(
    private readonly referralCodeService: ReferralCodeService,
    private readonly referralApplyService: ReferralApplyService,
  ) {}

  private audienceFromUrl(req: FastifyRequest): Audience {
    const url = req.url;
    if (url.includes('/driver/')) return 'DRIVER';
    return 'RIDER';
  }

  async getMe(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const audience = this.audienceFromUrl(req);
    const userId = callerId(req);
    reply.send({ data: await this.referralCodeService.getMe(userId, audience) });
  }

  async apply(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const audience = this.audienceFromUrl(req);
    const userId = callerId(req);
    const body = applyReferralBodySchema.parse(req.body ?? {});
    try {
      const result = await this.referralApplyService.applyAtSignup({
        code: body.code,
        refereeUserId: userId,
        audience,
      });
      reply.status(201).send({ data: result });
    } catch (err) {
      if (err instanceof ReferralError) {
        reply.status(err.statusCode).send({
          error: { code: err.code, message: err.message },
        });
        return;
      }
      throw err;
    }
  }
}
