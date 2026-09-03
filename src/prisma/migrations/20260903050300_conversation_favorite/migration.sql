-- Star/favorite toggle on inbox conversations.

ALTER TABLE "Conversation" ADD COLUMN "isFavorite" BOOLEAN NOT NULL DEFAULT false;
