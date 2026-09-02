import type { ProviderClient } from '../../../src/core/database';

type Prisma = ProviderClient;

interface DefaultTemplateSeed {
  eventKey: string;
  channel: 'SMS' | 'PUSH' | 'EMAIL' | 'IN_APP' | 'WHATSAPP';
  subject: string | null;
  body: string;
  variables: string[];
}

const DEFAULT_TEMPLATES: DefaultTemplateSeed[] = [
  {
    eventKey: 'otp_verification',
    channel: 'SMS',
    subject: null,
    body: 'Zaroorat: {{otp}} is your verification code. Do not share it with anyone.',
    variables: ['otp'],
  },
  {
    eventKey: 'welcome_rider',
    channel: 'PUSH',
    subject: 'Welcome to Zaroorat',
    body: 'Hi {{firstName}}, your account is ready. Book your first ride today.',
    variables: ['firstName'],
  },
  {
    eventKey: 'welcome_driver',
    channel: 'PUSH',
    subject: 'Welcome to Zaroorat Driver',
    body: 'Hi {{firstName}}, complete your profile to start earning with Zaroorat.',
    variables: ['firstName'],
  },
  {
    eventKey: 'driver_approved',
    channel: 'PUSH',
    subject: 'Driver application approved',
    body: 'Congratulations {{firstName}}! Your driver application has been approved.',
    variables: ['firstName'],
  },
  {
    eventKey: 'driver_rejected',
    channel: 'PUSH',
    subject: 'Driver application update',
    body: 'Hi {{firstName}}, your driver application needs attention. Please review the app for details.',
    variables: ['firstName'],
  },
  {
    eventKey: 'ride_assigned',
    channel: 'PUSH',
    subject: 'Driver assigned',
    body: 'Your driver {{driverName}} is on the way.',
    variables: ['driverName'],
  },
];

export async function seedNotificationTemplates(prisma: Prisma): Promise<void> {
  for (const template of DEFAULT_TEMPLATES) {
    const existing = await prisma.notificationTemplate.findFirst({
      where: { channel: template.channel, eventKey: template.eventKey },
    });

    if (existing) {
      await prisma.notificationTemplate.update({
        where: { id: existing.id },
        data: {
          code: template.eventKey,
          subject: template.subject,
          titleTemplate: template.subject,
          bodyTemplate: template.body,
          variables: template.variables,
          isActive: true,
        },
      });
      continue;
    }

    await prisma.notificationTemplate.create({
      data: {
        code: template.eventKey,
        eventKey: template.eventKey,
        channel: template.channel,
        subject: template.subject,
        titleTemplate: template.subject,
        bodyTemplate: template.body,
        variables: template.variables,
        isActive: true,
      },
    });
  }
}
