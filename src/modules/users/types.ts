// Re-export the USER-owned Prisma models so feature code never deep-imports the
// generated client (mirrors `@core/database/types` for the auth models).
export type { UserProfile, EmergencyContact, SavedPlace } from '../../generated/prisma';
