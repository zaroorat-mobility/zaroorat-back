import { z } from 'zod';

export const submitRatingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(50)).max(10).optional(),
  comment: z.string().max(500).optional(),
});
export type SubmitRatingBody = z.infer<typeof submitRatingSchema>;
