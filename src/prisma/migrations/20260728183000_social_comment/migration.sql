-- CreateTable
CREATE TABLE "SocialComment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "parentCommentId" TEXT,
    "commenterUsername" TEXT,
    "commenterProfilePic" TEXT,
    "commentText" TEXT NOT NULL,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "classificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "classificationError" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "suggestedReply" TEXT,
    "postCaption" TEXT,
    "postThumbnailUrl" TEXT,
    "commentedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialComment_workspaceId_commentId_key" ON "SocialComment"("workspaceId", "commentId");

-- CreateIndex
CREATE INDEX "SocialComment_workspaceId_status_idx" ON "SocialComment"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "SocialComment_workspaceId_postId_idx" ON "SocialComment"("workspaceId", "postId");

-- CreateIndex
CREATE INDEX "SocialComment_socialAccountId_idx" ON "SocialComment"("socialAccountId");

-- CreateIndex
CREATE INDEX "SocialComment_classificationStatus_idx" ON "SocialComment"("classificationStatus");

-- AddForeignKey
ALTER TABLE "SocialComment" ADD CONSTRAINT "SocialComment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialComment" ADD CONSTRAINT "SocialComment_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
