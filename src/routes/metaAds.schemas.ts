import { z } from 'zod';

export const metaAdsSelectAccountBodySchema = z.object({
  adAccountId: z.string().optional(),
});

export const metaAdsConnectBodySchema = z.object({
  code: z.string().optional(),
  redirectUri: z.string().optional(),
  adAccountId: z.string().optional(),
});

export const metaAdsCampaignParamsSchema = z.object({
  id: z.string(),
});

export const metaAdsCtwaCreateBodySchema = z.object({
  campaignName: z.string().optional(),
  dailyBudget: z.number().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  headline: z.string().optional(),
  description: z.string().optional(),
  targeting: z
    .object({
      ageMin: z.number().optional(),
      ageMax: z.number().optional(),
      locations: z.array(z.string()).optional(),
    })
    .optional(),
});
