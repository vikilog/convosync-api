import type { Prisma } from '@prisma/client';
import { prisma } from '../../../../index.js';

export const gbpReviewRepository = {
  async listByLocation(workspaceId: string, locationId: string) {
    return prisma.googleBusinessReview.findMany({
      where: { workspaceId, locationId },
      orderBy: { updateTime: 'desc' },
    });
  },

  async upsertMany(
    workspaceId: string,
    connectionId: string,
    locationId: string,
    reviews: Array<{
      googleReviewId: string;
      reviewerName?: string | null;
      starRating?: number | null;
      comment?: string | null;
      reviewReply?: string | null;
      createTime?: Date | null;
      updateTime?: Date | null;
      rawData?: Prisma.InputJsonValue;
    }>
  ) {
    const now = new Date();
    for (const review of reviews) {
      await prisma.googleBusinessReview.upsert({
        where: {
          locationId_googleReviewId: {
            locationId,
            googleReviewId: review.googleReviewId,
          },
        },
        create: {
          workspaceId,
          connectionId,
          locationId,
          googleReviewId: review.googleReviewId,
          reviewerName: review.reviewerName ?? null,
          starRating: review.starRating ?? null,
          comment: review.comment ?? null,
          reviewReply: review.reviewReply ?? null,
          createTime: review.createTime ?? null,
          updateTime: review.updateTime ?? null,
          rawData: review.rawData ?? undefined,
          lastSyncedAt: now,
        },
        update: {
          reviewerName: review.reviewerName ?? null,
          starRating: review.starRating ?? null,
          comment: review.comment ?? null,
          reviewReply: review.reviewReply ?? null,
          createTime: review.createTime ?? null,
          updateTime: review.updateTime ?? null,
          rawData: review.rawData ?? undefined,
          lastSyncedAt: now,
        },
      });
    }

    await prisma.googleBusinessLocation.update({
      where: { id: locationId },
      data: { lastReviewSyncAt: now },
    });
  },

  async latestSync(workspaceId: string, connectionId: string) {
    return prisma.googleBusinessReview.aggregate({
      where: { workspaceId, connectionId },
      _max: { lastSyncedAt: true },
      _count: true,
    });
  },
};
