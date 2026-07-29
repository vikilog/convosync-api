-- Instagram connect used to auto-create MessengerAccount rows. Those empty
-- inbox tabs confused users who only connected Instagram. Remove Messenger
-- accounts that never received a Messenger conversation; explicit Messenger
-- connect still creates accounts going forward (without IG auto-enable).
DELETE FROM "MessengerAccount" AS ma
WHERE NOT EXISTS (
  SELECT 1
  FROM "Conversation" AS c
  WHERE c."workspaceId" = ma."workspaceId"
    AND c.channel = 'messenger'
    AND c."channelAccountId" = ma."pageId"
);
