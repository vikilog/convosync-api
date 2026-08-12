-- Best-effort PII / secret scrub for a *dev* restore of ConvoSync Postgres.
-- Limits: does not rewrite media on S3, encrypted blobs become empty (not decryptable),
-- customFields JSON keys vary per workspace, email_logs / call transcripts may retain fragments.
-- Run only against convosync_dev (enforced by db-refresh-dev.sh).

BEGIN;

UPDATE "Contact"
SET
  phone = '91' || lpad((abs(hashtext(id || "workspaceId")) % 10000000000)::text, 10, '0'),
  email = CASE WHEN email IS NULL THEN NULL ELSE 'dev+' || id || '@example.invalid' END,
  name = 'Dev Contact ' || left(id, 8),
  "customFields" = NULL;

UPDATE "Conversation"
SET "lastMessage" = CASE WHEN "lastMessage" IS NULL THEN NULL ELSE '[redacted]' END;

UPDATE "Message"
SET
  content = '[redacted]',
  metadata = NULL;

UPDATE "Workspace"
SET
  phone = CASE WHEN phone IS NULL THEN NULL ELSE '+910000000000' END,
  email = CASE WHEN email IS NULL THEN NULL ELSE 'workspace+' || id || '@example.invalid' END,
  "waToken" = NULL,
  "waPhoneNumber" = CASE WHEN "waPhoneNumber" IS NULL THEN NULL ELSE '+910000000000' END,
  "fbPageToken" = NULL,
  "metaUserToken" = NULL;

UPDATE "WhatsAppPhoneAccount"
SET "phoneNumber" = CASE WHEN "phoneNumber" IS NULL THEN NULL ELSE '+910000000000' END;

UPDATE "InstagramAccount"
SET "pageAccessToken" = 'scrubbed';

UPDATE "MessengerAccount"
SET "pageAccessToken" = 'scrubbed';

UPDATE "GoogleConnection"
SET "encryptedTokens" = 'scrubbed';

UPDATE "workspace_ai_provider_configs"
SET "encryptedCredentials" = NULL;

UPDATE "workspace_email_configs"
SET
  "accessKeyIdEncrypted" = NULL,
  "secretAccessKeyEncrypted" = NULL;

UPDATE "email_provider_configs"
SET "encryptedConfig" = '';

UPDATE "AiKnowledgeConfig"
SET "connectionString" = NULL;

UPDATE "developer_incoming_webhooks"
SET secret = 'scrubbed';

UPDATE "developer_outgoing_webhooks"
SET secret = CASE WHEN secret IS NULL THEN NULL ELSE 'scrubbed' END;

UPDATE "User"
SET
  phone = CASE WHEN phone IS NULL THEN NULL ELSE '+910000000000' END,
  email = 'user+' || id || '@example.invalid';

UPDATE "SocialComment"
SET
  "commentText" = '[redacted]',
  "suggestedReply" = CASE WHEN "suggestedReply" IS NULL THEN NULL ELSE '[redacted]' END,
  "publicReplyText" = CASE WHEN "publicReplyText" IS NULL THEN NULL ELSE '[redacted]' END,
  "dmReplyText" = CASE WHEN "dmReplyText" IS NULL THEN NULL ELSE '[redacted]' END;

UPDATE "contact_insights"
SET
  summary = '[redacted]',
  "painPoints" = '[]'::jsonb,
  interests = '[]'::jsonb,
  "recommendedAction" = NULL;

COMMIT;
