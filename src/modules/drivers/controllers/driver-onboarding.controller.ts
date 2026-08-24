import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DriverService } from '../services/driver.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { updateDriverProfileSchema, reviewVerificationSchema } from '../schemas/driver.schemas.js';
import { actingDriverId } from './driver-identity.js';
import { DriverNotFoundError } from '../errors/driver.errors.js';

export class DriverOnboardingController {
  constructor(
    private readonly driverService: DriverService,
    private readonly driverRepository: DriverRepository,
  ) {}

  async getMe(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driver = await this.driverRepository.findByUserId(callerId(req));
    if (!driver) throw new DriverNotFoundError(callerId(req));
    reply.send({ data: driver });
  }

  async onboard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driver = await this.driverService.onboarding.onboardDriver(callerId(req));
    reply.status(201).send({ data: driver });
  }

  async updateProfile(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const body = updateDriverProfileSchema.parse(req.body);

    const updateParams: Record<string, unknown> = {};
    if (body.fullLegalName !== undefined) updateParams.fullLegalName = body.fullLegalName;
    if (body.dateOfBirth !== undefined) updateParams.dateOfBirth = new Date(body.dateOfBirth);
    if (body.gender !== undefined) updateParams.gender = body.gender;
    if (body.addressLine !== undefined) updateParams.addressLine = body.addressLine;
    if (body.city !== undefined) updateParams.city = body.city;
    if (body.state !== undefined) updateParams.state = body.state;
    if (body.postalCode !== undefined) updateParams.postalCode = body.postalCode;
    if (body.preferredLanguage !== undefined) {
      updateParams.preferredLanguage = body.preferredLanguage;
    }
    if (body.bloodGroup !== undefined) updateParams.bloodGroup = body.bloodGroup;
    if (body.alternatePhone !== undefined) updateParams.alternatePhone = body.alternatePhone;
    if (body.drivingExperienceYears !== undefined) {
      updateParams.drivingExperienceYears = body.drivingExperienceYears;
    }
    if (body.email !== undefined) updateParams.email = body.email;

    const profile = await this.driverService.onboarding.updateProfile(
      callerId(req),
      driverId,
      updateParams,
    );

    reply.send({ data: profile });
  }

  async reviewVerification(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as {
      id: string;
    };
    const approvedBy = callerId(req);
    const body = reviewVerificationSchema.parse(req.body);

    const driver = await this.driverService.onboarding.reviewDriverVerification(
      id,
      body.status,
      approvedBy,
      body.rejectionReason,
    );

    req.log.warn(
      { driverId: id, status: body.status, reviewerUserId: approvedBy },
      '[drivers] verification decision recorded',
    );

    reply.send({ data: driver });
  }
}
