/**
 * First system_admin bootstrap. Run once per environment, after migrations and the seed:
 *
 *   read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD          # 12+ characters, no echo
 *   export ADMIN_EMAIL=... ADMIN_PHONE=+91...                 # a phone the owner controls
 *   docker compose ... run --rm -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD \
 *     -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME ops npx tsx scripts/create-admin.ts
 *
 * Refuses, rather than guesses, whenever it could hurt someone:
 *  - a system_admin already exists (pass --additional to add another on purpose);
 *  - the email or phone belongs to ANY existing account: it never takes an account over;
 *  - an input is missing or weak: there are no defaults, admin OTP login works by phone.
 * The user, the role grant and the audit row are written in one transaction, under a lock,
 * so two simultaneous runs cannot both create an admin.
 */
import { container } from '../src/core/di';
import { DatabaseService, type ProviderClient } from '../src/core/database';
import { PrismaClientProvider } from '../src/core/database/client/PrismaClientProvider';
import { hashPassword } from '../src/modules/auth/utils/password';
import { recordAdminAction } from '../src/modules/admin/audit/index.js';

export class AdminBootstrapRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminBootstrapRefusal';
  }
}

export interface AdminBootstrapInput {
  email: string;
  phone: string;
  password: string;
  firstName: string;
  lastName: string;
}

const MIN_PASSWORD_LENGTH = 12;

export function readAdminBootstrapInput(env: NodeJS.ProcessEnv): AdminBootstrapInput {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const phone = env.ADMIN_PHONE?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdminBootstrapRefusal('ADMIN_EMAIL is required and must be an email address.');
  }
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new AdminBootstrapRefusal(
      'ADMIN_PHONE is required in E.164 form (+91...). Use a number the platform owner controls: admin OTP login works by phone.',
    );
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new AdminBootstrapRefusal(
      `ADMIN_PASSWORD is required and must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  return {
    email,
    phone,
    password,
    firstName: env.ADMIN_FIRST_NAME?.trim() || 'Platform',
    lastName: env.ADMIN_LAST_NAME?.trim() || 'Admin',
  };
}

export async function createFirstAdmin(
  prisma: ProviderClient,
  input: AdminBootstrapInput,
  options: { allowAdditional: boolean },
): Promise<{ userId: string }> {
  const passwordHash = hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('scripts/create-admin'))`;

    const activeAdmins = await tx.userRoleAssignment.count({
      where: {
        revokedAt: null,
        role: { slug: 'system_admin' },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (activeAdmins > 0 && !options.allowAdditional) {
      throw new AdminBootstrapRefusal(
        'A system_admin already exists. Create further staff in the admin panel (Staff Management), or pass --additional to add another system_admin on purpose.',
      );
    }

    const clash = await tx.user.findFirst({
      where: {
        OR: [{ email: { equals: input.email, mode: 'insensitive' } }, { phoneNumber: input.phone }],
      },
      select: { id: true },
    });
    if (clash) {
      throw new AdminBootstrapRefusal(
        'ADMIN_EMAIL or ADMIN_PHONE already belongs to an existing account. This script never takes an account over: use a new email and phone, or grant the role from the admin panel.',
      );
    }

    const role = await tx.role.findUnique({ where: { slug: 'system_admin' } });
    if (!role) {
      throw new AdminBootstrapRefusal('Role system_admin is not seeded. Run the seed first.');
    }

    const user = await tx.user.create({
      data: {
        email: input.email,
        phoneNumber: input.phone,
        passwordHash,
        status: 'ACTIVE',
        isEmailVerified: true,
        isPhoneVerified: true,
        profile: { create: { firstName: input.firstName, lastName: input.lastName } },
      },
    });
    await tx.userRoleAssignment.create({ data: { userId: user.id, roleId: role.id } });
    await recordAdminAction(tx, {
      actorId: user.id,
      action: 'CREATE',
      entityType: 'user',
      entityId: user.id,
      summary: 'system_admin bootstrapped by scripts/create-admin.ts',
      result: 'SUCCESS',
      ...(options.allowAdditional ? { notes: 'additional system_admin (--additional)' } : {}),
    });
    return { userId: user.id };
  });
}

async function main(): Promise<void> {
  const input = readAdminBootstrapInput(process.env);
  const provider = container.resolve<PrismaClientProvider>('provider');
  const prisma = container.resolve<DatabaseService>('databaseService').client;
  try {
    const { userId } = await createFirstAdmin(prisma, input, {
      allowAdditional: process.argv.includes('--additional'),
    });
    console.log(`system_admin created: ${userId} (${input.email})`);
  } finally {
    await provider.disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err instanceof AdminBootstrapRefusal ? `Refused: ${err.message}` : err);
      process.exit(1);
    });
}
