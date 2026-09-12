-- Browser calling: Plivo Endpoint (SIP/WebRTC identity) + Application (inbound routing).

ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "plivoEndpointId" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "plivoEndpointUsername" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "plivoEndpointPassword" TEXT;
ALTER TABLE "virtual_number_requests" ADD COLUMN IF NOT EXISTS "plivoAppId" TEXT;
