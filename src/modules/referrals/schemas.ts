import { z } from 'zod';

export const applyReferralBodySchema = z.object({
  code: z.string().trim().min(2).max(50),
});

export type ApplyReferralBody = z.infer<typeof applyReferralBodySchema>;
