import { DatabaseService } from '@core/database';
import { Prisma } from '../../../../generated/prisma/index.js';
import { recordAdminAction } from '../../audit/index.js';
import type { PrismaTx } from '../operations.types.js';
import { SafetyIncidentNotFoundError, OperationsValidationError } from '../operations.errors.js';
import type {
  ListSafetyIncidentsQuery,
  CreateSafetyIncidentBody,
  AcknowledgeIncidentBody,
  ResolveIncidentBody,
  EscalateIncidentBody,
  AddIncidentNoteBody,
  AttachEvidenceBody,
} from './incident.schemas.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminSafetyIncidentListItemDto {
  id: string;
  incidentNumber: string;
  type: string;
  severity: string;
  status: string;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  locationAddress: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionType: string | null;
  resolutionNotes: string | null;
  evidenceFileIds: string[];
  createdAt: string;
  updatedAt: string;
  reporter: {
    id: string;
    fullName: string;
    phone: string;
    avatarUrl: string | null;
  };
  subject: {
    id: string;
    fullName: string;
    phone: string;
  } | null;
  ride: {
    id: string;
    rideCode: string;
    status: string;
    driverName: string | null;
    driverPhone: string | null;
    pickupAddress: string | null;
    dropAddress: string | null;
  } | null;
  eventsCount: number;
}

export interface AdminSafetyIncidentDetailDto extends AdminSafetyIncidentListItemDto {
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  events: Array<{
    id: string;
    eventType: string;
    actorId: string | null;
    actorName: string | null;
    notes: string | null;
    metadata: Prisma.JsonValue | null;
    createdAt: string;
  }>;
}

export class AdminSafetyService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async list(query: ListSafetyIncidentsQuery): Promise<{
    data: AdminSafetyIncidentListItemDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = Math.max(1, query.page);
    const limit = Math.max(1, Math.min(100, query.limit));
    const skip = (page - 1) * limit;

    const where: Prisma.SafetyIncidentWhereInput = {};

    if (query.status && query.status !== 'all') {
      where.status = query.status;
    }

    if (query.type && query.type !== 'all') {
      where.type = query.type;
    }

    if (query.severity && query.severity !== 'all') {
      where.severity = query.severity;
    }

    if (query.rideId) {
      where.rideId = query.rideId;
    }

    if (query.reporterUserId) {
      where.reporterUserId = query.reporterUserId;
    }

    if (query.search) {
      const s = query.search;
      where.OR = [
        { incidentNumber: { contains: s, mode: 'insensitive' } },
        { description: { contains: s, mode: 'insensitive' } },
        { locationAddress: { contains: s, mode: 'insensitive' } },
        { reporterUser: { phoneNumber: { contains: s } } },
        { reporterUser: { profile: { firstName: { contains: s, mode: 'insensitive' } } } },
        { reporterUser: { profile: { lastName: { contains: s, mode: 'insensitive' } } } },
      ];
    }

    const [total, incidents] = await Promise.all([
      this.client.safetyIncident.count({ where }),
      this.client.safetyIncident.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          reporterUser: {
            include: {
              profile: true,
            },
          },
          subjectUser: {
            include: {
              profile: true,
            },
          },
          ride: {
            include: {
              driver: {
                include: {
                  profile: true,
                  user: {
                    include: {
                      profile: true,
                    },
                  },
                },
              },
            },
          },
          _count: {
            select: {
              events: true,
            },
          },
        },
      }),
    ]);

    const data = incidents.map((inc) => this.mapToListItemDto(inc));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getById(idOrNumber: string): Promise<AdminSafetyIncidentDetailDto> {
    const isUuid = UUID_REGEX.test(idOrNumber);
    const where = isUuid ? { id: idOrNumber } : { incidentNumber: idOrNumber };

    const incident = await this.client.safetyIncident.findFirst({
      where,
      include: {
        reporterUser: {
          include: {
            profile: true,
          },
        },
        subjectUser: {
          include: {
            profile: true,
          },
        },
        ride: {
          include: {
            driver: {
              include: {
                profile: true,
                user: {
                  include: {
                    profile: true,
                  },
                },
              },
            },
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
          include: {
            actor: {
              include: {
                profile: true,
              },
            },
          },
        },
        _count: {
          select: {
            events: true,
          },
        },
      },
    });

    if (!incident) {
      throw new SafetyIncidentNotFoundError(`Safety incident '${idOrNumber}' not found`);
    }

    return this.mapToDetailDto(incident);
  }

  async create(
    body: CreateSafetyIncidentBody,
    actorId?: string,
  ): Promise<AdminSafetyIncidentDetailDto> {
    let reporterId = body.reporterUserId;

    if (!reporterId && body.reporterPhone) {
      const u = await this.client.user.findFirst({
        where: { phoneNumber: body.reporterPhone },
      });
      if (u) {
        reporterId = u.id;
      }
    }

    if (!reporterId) {
      const firstUser = await this.client.user.findFirst();
      if (firstUser) {
        reporterId = firstUser.id;
      } else {
        throw new OperationsValidationError('A valid reporterUserId is required');
      }
    }

    const typePrefix = body.type === 'SOS' ? 'SOS' : 'INC';
    const incidentNumber = `${typePrefix}-${Math.floor(100000 + Math.random() * 900000)}`;

    const created = await this.client.$transaction(async (tx: PrismaTx) => {
      const inc = await tx.safetyIncident.create({
        data: {
          incidentNumber,
          type: body.type ?? 'SOS',
          severity: body.severity ?? 'HIGH',
          status: 'OPEN',
          rideId: body.rideId ?? null,
          reporterUserId: reporterId!,
          subjectUserId: body.subjectUserId ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          locationAddress: body.locationAddress ?? null,
          description: body.description,
          evidenceFileIds: body.evidenceFileIds ?? [],
        },
      });

      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: inc.id,
          eventType: 'TRIGGERED',
          actorId: reporterId,
          notes: `Safety incident triggered: ${body.description}`,
          metadata: {
            type: inc.type,
            severity: inc.severity,
            latitude: inc.latitude,
            longitude: inc.longitude,
          },
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'safety_incident',
        entityId: inc.id,
        summary: `Created safety incident ${inc.incidentNumber} (${inc.type})`,
        after: inc,
      });

      return inc;
    });

    return this.getById(created.id);
  }

  async acknowledge(
    id: string,
    body: AcknowledgeIncidentBody,
    actorId?: string,
  ): Promise<AdminSafetyIncidentDetailDto> {
    const inc = await this.client.safetyIncident.findUnique({
      where: { id },
    });

    if (!inc) {
      throw new SafetyIncidentNotFoundError(`Safety incident '${id}' not found`);
    }

    const now = new Date();

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.safetyIncident.update({
        where: { id: inc.id },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedAt: now,
          acknowledgedBy: actorId ?? null,
        },
      });

      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: inc.id,
          eventType: 'ACKNOWLEDGED',
          actorId: actorId ?? null,
          notes: body.notes ?? 'Safety incident acknowledged by operations staff.',
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'safety_incident',
        entityId: inc.id,
        summary: `Acknowledged safety incident ${inc.incidentNumber}`,
        before: { status: inc.status },
        after: { status: 'ACKNOWLEDGED', acknowledgedAt: now },
      });
    });

    return this.getById(inc.id);
  }

  async resolve(
    id: string,
    body: ResolveIncidentBody,
    actorId?: string,
  ): Promise<AdminSafetyIncidentDetailDto> {
    const inc = await this.client.safetyIncident.findUnique({
      where: { id },
    });

    if (!inc) {
      throw new SafetyIncidentNotFoundError(`Safety incident '${id}' not found`);
    }

    const now = new Date();
    const status = body.status || 'RESOLVED';

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.safetyIncident.update({
        where: { id: inc.id },
        data: {
          status,
          resolvedAt: now,
          resolvedBy: actorId ?? null,
          resolutionType: body.resolutionType,
          resolutionNotes: body.resolutionNotes,
        },
      });

      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: inc.id,
          eventType: 'RESOLVED',
          actorId: actorId ?? null,
          notes: `[${body.resolutionType}]: ${body.resolutionNotes}`,
          metadata: {
            resolutionType: body.resolutionType,
          },
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'safety_incident',
        entityId: inc.id,
        summary: `Resolved safety incident ${inc.incidentNumber} as ${body.resolutionType}. Notes: ${body.resolutionNotes}`,
        before: { status: inc.status },
        after: { status, resolvedAt: now, resolutionType: body.resolutionType },
      });
    });

    return this.getById(inc.id);
  }

  async escalate(
    id: string,
    body: EscalateIncidentBody,
    actorId?: string,
  ): Promise<AdminSafetyIncidentDetailDto> {
    const inc = await this.client.safetyIncident.findUnique({
      where: { id },
    });

    if (!inc) {
      throw new SafetyIncidentNotFoundError(`Safety incident '${id}' not found`);
    }

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.safetyIncident.update({
        where: { id: inc.id },
        data: {
          severity: body.severity ?? 'CRITICAL',
          status: 'INVESTIGATING',
        },
      });

      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: inc.id,
          eventType: 'ESCALATED',
          actorId: actorId ?? null,
          notes: `Escalated to ${body.severity}: ${body.notes}`,
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'safety_incident',
        entityId: inc.id,
        summary: `Escalated safety incident ${inc.incidentNumber} to ${body.severity}`,
        before: { severity: inc.severity, status: inc.status },
        after: { severity: body.severity, status: 'INVESTIGATING' },
      });
    });

    return this.getById(inc.id);
  }

  async addNote(
    id: string,
    body: AddIncidentNoteBody,
    actorId?: string,
  ): Promise<AdminSafetyIncidentDetailDto> {
    const inc = await this.client.safetyIncident.findUnique({
      where: { id },
    });

    if (!inc) {
      throw new SafetyIncidentNotFoundError(`Safety incident '${id}' not found`);
    }

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: inc.id,
          eventType: 'NOTE',
          actorId: actorId ?? null,
          notes: body.notes,
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'safety_incident_event',
        entityId: inc.id,
        summary: `Added investigation note to safety incident ${inc.incidentNumber}`,
      });
    });

    return this.getById(inc.id);
  }

  async attachEvidence(
    id: string,
    body: AttachEvidenceBody,
    actorId?: string,
  ): Promise<AdminSafetyIncidentDetailDto> {
    const inc = await this.client.safetyIncident.findUnique({
      where: { id },
    });

    if (!inc) {
      throw new SafetyIncidentNotFoundError(`Safety incident '${id}' not found`);
    }

    const updatedFileIds = Array.from(new Set([...(inc.evidenceFileIds || []), body.fileId]));

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.safetyIncident.update({
        where: { id: inc.id },
        data: {
          evidenceFileIds: updatedFileIds,
        },
      });

      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: inc.id,
          eventType: 'EVIDENCE_ATTACHED',
          actorId: actorId ?? null,
          notes: `Attached evidence file: ${body.fileId}`,
          metadata: { fileId: body.fileId },
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'safety_incident',
        entityId: inc.id,
        summary: `Attached evidence file ${body.fileId} to incident ${inc.incidentNumber}`,
      });
    });

    return this.getById(inc.id);
  }

  private mapToListItemDto(
    inc: Prisma.SafetyIncidentGetPayload<{
      include: {
        reporterUser: { include: { profile: true } };
        subjectUser: { include: { profile: true } };
        ride: {
          include: {
            driver: {
              include: {
                profile: true;
                user: { include: { profile: true } };
              };
            };
          };
        };
        _count: { select: { events: true } };
      };
    }>,
  ): AdminSafetyIncidentListItemDto {
    const reporterName =
      [inc.reporterUser?.profile?.firstName, inc.reporterUser?.profile?.lastName]
        .filter(Boolean)
        .join(' ') || 'Reporter';

    const subjectName = inc.subjectUser
      ? [inc.subjectUser.profile?.firstName, inc.subjectUser.profile?.lastName]
          .filter(Boolean)
          .join(' ') || 'Subject'
      : null;

    const driverName = inc.ride?.driver
      ? [inc.ride.driver.user?.profile?.firstName, inc.ride.driver.user?.profile?.lastName]
          .filter(Boolean)
          .join(' ') ||
        inc.ride.driver.profile?.fullLegalName ||
        'Driver'
      : null;

    return {
      id: inc.id,
      incidentNumber: inc.incidentNumber,
      type: inc.type,
      severity: inc.severity,
      status: inc.status,
      description: inc.description ?? null,
      latitude: inc.latitude ?? null,
      longitude: inc.longitude ?? null,
      locationAddress: inc.locationAddress ?? null,
      acknowledgedAt: inc.acknowledgedAt ? inc.acknowledgedAt.toISOString() : null,
      resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
      resolutionType: inc.resolutionType ?? null,
      resolutionNotes: inc.resolutionNotes ?? null,
      evidenceFileIds: inc.evidenceFileIds ?? [],
      createdAt: inc.createdAt.toISOString(),
      updatedAt: inc.updatedAt.toISOString(),
      reporter: {
        id: inc.reporterUserId,
        fullName: reporterName,
        phone: inc.reporterUser?.phoneNumber ?? '',
        avatarUrl: inc.reporterUser?.profile?.profileImageFileId ?? null,
      },
      subject: inc.subjectUser
        ? {
            id: inc.subjectUser.id,
            fullName: subjectName || 'Subject',
            phone: inc.subjectUser.phoneNumber ?? '',
          }
        : null,
      ride: inc.ride
        ? {
            id: inc.ride.id,
            rideCode: inc.ride.rideCode,
            status: inc.ride.status,
            driverName,
            driverPhone: inc.ride.driver?.user?.phoneNumber ?? null,
            pickupAddress: inc.ride.pickupAddress ?? null,
            dropAddress: inc.ride.dropAddress ?? null,
          }
        : null,
      eventsCount: inc._count?.events ?? 0,
    };
  }

  private mapToDetailDto(
    inc: Prisma.SafetyIncidentGetPayload<{
      include: {
        reporterUser: { include: { profile: true } };
        subjectUser: { include: { profile: true } };
        ride: {
          include: {
            driver: {
              include: {
                profile: true;
                user: { include: { profile: true } };
              };
            };
          };
        };
        events: {
          include: { actor: { include: { profile: true } } };
        };
        _count: { select: { events: true } };
      };
    }>,
  ): AdminSafetyIncidentDetailDto {
    const base = this.mapToListItemDto(inc);

    const events = (inc.events || []).map((e) => {
      const actorName = e.actor
        ? [e.actor.profile?.firstName, e.actor.profile?.lastName].filter(Boolean).join(' ') ||
          'Staff'
        : 'System';

      return {
        id: e.id,
        eventType: e.eventType,
        actorId: e.actorId ?? null,
        actorName,
        notes: e.notes ?? null,
        metadata: e.metadata ?? null,
        createdAt: e.createdAt.toISOString(),
      };
    });

    return {
      ...base,
      acknowledgedBy: inc.acknowledgedBy ?? null,
      resolvedBy: inc.resolvedBy ?? null,
      events,
    };
  }
}
