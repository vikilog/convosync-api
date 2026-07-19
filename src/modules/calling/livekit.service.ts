import {
  AccessToken,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  type EgressInfo,
} from 'livekit-server-sdk';
import { config } from '../../config.js';
import { isObjectStorageEnabled } from '../../services/objectStorage.js';
import { CallingError } from './calling.types.js';

export function isLiveKitConfigured(): boolean {
  return config.livekit.enabled;
}

function requireLiveKit() {
  if (!config.livekit.enabled) {
    throw new CallingError(
      'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.',
      503,
      'livekit_not_configured'
    );
  }
}

function roomClient(): RoomServiceClient {
  requireLiveKit();
  return new RoomServiceClient(
    config.livekit.url,
    config.livekit.apiKey,
    config.livekit.apiSecret
  );
}

function egressClient(): EgressClient {
  requireLiveKit();
  return new EgressClient(config.livekit.url, config.livekit.apiKey, config.livekit.apiSecret);
}

export type MintLiveKitTokenInput = {
  roomName: string;
  identity: string;
  name?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  metadata?: string;
};

/** Short-lived room join token — API secret never leaves the server. */
export async function mintLiveKitAccessToken(input: MintLiveKitTokenInput): Promise<{
  token: string;
  url: string;
  expiresInSeconds: number;
}> {
  requireLiveKit();
  const ttl = config.livekit.tokenTtlSeconds;
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: input.identity,
    name: input.name,
    metadata: input.metadata,
    ttl,
  });
  at.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: input.canPublish ?? true,
    canSubscribe: input.canSubscribe ?? true,
    canPublishData: false,
  });
  const token = await at.toJwt();
  return { token, url: config.livekit.url, expiresInSeconds: ttl };
}

/**
 * Explicit room create so emptyTimeout cleans orphans.
 * LiveKit also auto-creates on first join; create is idempotent enough (ignore already exists).
 */
export async function ensureLiveKitRoom(roomName: string): Promise<void> {
  if (!config.livekit.enabled) return;
  try {
    await roomClient().createRoom({
      name: roomName,
      // ponytail: 30m empty — upgrade path: per-workspace policy
      emptyTimeout: 30 * 60,
      departureTimeout: 20,
      maxParticipants: 8,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|conflict/i.test(msg)) {
      console.warn('[calling] createRoom failed', roomName, err);
    }
  }
}

/** Best-effort room delete to prevent orphans. No-op if LiveKit not configured. */
export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  if (!config.livekit.enabled) return;
  try {
    await roomClient().deleteRoom(roomName);
  } catch (err) {
    console.warn('[calling] LiveKit deleteRoom failed', roomName, err);
  }
}

export function buildCallRoomName(workspaceId: string, callSessionId: string): string {
  return `ws_${workspaceId}_call_${callSessionId}`;
}

export function agentLiveKitIdentity(userId: string): string {
  return `agent:${userId}`;
}

/** Headless Pipecat bot participant in the customer call room. */
export function aiVoiceAgentLiveKitIdentity(): string {
  return 'ai-agent';
}

export function listenerLiveKitIdentity(userId: string): string {
  return `listener:${userId}`;
}

/** Send reliable take_over data packet to the Pipecat participant. */
export async function sendTakeOverToAiAgent(input: {
  roomName: string;
  callSessionId: string;
}): Promise<void> {
  requireLiveKit();
  const { DataPacket_Kind } = await import('@livekit/protocol');
  const payload = Buffer.from(
    JSON.stringify({
      type: 'take_over',
      callSessionId: input.callSessionId,
      at: new Date().toISOString(),
    }),
    'utf8'
  );
  await roomClient().sendData(input.roomName, payload, DataPacket_Kind.RELIABLE, {
    destinationIdentities: [aiVoiceAgentLiveKitIdentity()],
  });
}

export async function listRoomParticipantIdentities(roomName: string): Promise<string[]> {
  requireLiveKit();
  try {
    const list = await roomClient().listParticipants(roomName);
    return list.map((p) => p.identity).filter(Boolean);
  } catch (err) {
    console.warn('[calling] listParticipants failed', roomName, err);
    return [];
  }
}

export async function removeAiVoiceAgentFromRoom(roomName: string): Promise<void> {
  requireLiveKit();
  try {
    await roomClient().removeParticipant(roomName, aiVoiceAgentLiveKitIdentity());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found|does not exist|participant/i.test(msg)) {
      console.warn('[calling] removeParticipant ai-agent failed', roomName, err);
    }
  }
}

/**
 * Ask Pipecat to leave gracefully; if still present after delay, force-remove.
 */
export async function signalAiAgentTakeOver(input: {
  roomName: string;
  callSessionId: string;
  forceRemoveAfterMs?: number;
}): Promise<void> {
  try {
    await sendTakeOverToAiAgent({
      roomName: input.roomName,
      callSessionId: input.callSessionId,
    });
  } catch (err) {
    console.warn('[calling] sendTakeOver data failed', input.callSessionId, err);
  }

  const waitMs = input.forceRemoveAfterMs ?? 2000;
  await sleep(waitMs);
  const ids = await listRoomParticipantIdentities(input.roomName);
  if (ids.includes(aiVoiceAgentLiveKitIdentity())) {
    await removeAiVoiceAgentFromRoom(input.roomName);
  }
}

export function customerLiveKitIdentity(contactId: string): string {
  return `customer:${contactId}`;
}

/** Storage key relative to AWS_S3_PREFIX / local uploads root. */
export function callRecordingStorageKey(
  workspaceId: string,
  callId: string,
  ext = 'ogg'
): string {
  const clean = (ext || 'ogg').replace(/^\./, '').toLowerCase() || 'ogg';
  return `${workspaceId}/calls/${callId}.${clean}`;
}

function buildEncodedFileOutput(workspaceId: string, callId: string): EncodedFileOutput {
  const storageKey = callRecordingStorageKey(workspaceId, callId);
  const filepath = config.aws.s3Prefix ? `${config.aws.s3Prefix}/${storageKey}` : storageKey;

  if (isObjectStorageEnabled()) {
    return new EncodedFileOutput({
      fileType: EncodedFileType.OGG,
      filepath,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: config.aws.accessKeyId,
          secret: config.aws.secretAccessKey,
          region: config.aws.region,
          bucket: config.aws.bucketName,
          endpoint: config.aws.s3Endpoint || undefined,
          forcePathStyle: Boolean(config.aws.s3Endpoint),
        }),
      },
    });
  }

  // LiveKit Cloud temp file → we download on stop (local putObject)
  return new EncodedFileOutput({
    fileType: EncodedFileType.OGG,
    filepath: storageKey,
  });
}

/** Start audio-only room composite egress. Returns egress id. */
export async function startCallRecording(input: {
  roomName: string;
  workspaceId: string;
  callId: string;
}): Promise<{ egressId: string; storageKey: string }> {
  requireLiveKit();
  const storageKey = callRecordingStorageKey(input.workspaceId, input.callId);
  const info = await egressClient().startRoomCompositeEgress(
    input.roomName,
    buildEncodedFileOutput(input.workspaceId, input.callId),
    { audioOnly: true }
  );
  if (!info.egressId) {
    throw new CallingError('Failed to start recording', 502, 'recording_start_failed');
  }
  return { egressId: info.egressId, storageKey };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type FinalizedRecording = {
  status: 'ready' | 'failed' | 'skipped';
  storageKey?: string;
  location?: string;
  durationSeconds?: number;
  fileSize?: number;
  codec: string;
  error?: string;
  startedAt?: Date;
  endedAt?: Date;
};

async function waitForEgress(
  egressId: string,
  timeoutMs = 55_000
): Promise<EgressInfo | null> {
  const client = egressClient();
  const deadline = Date.now() + timeoutMs;
  let last: EgressInfo | null = null;
  while (Date.now() < deadline) {
    const list = await client.listEgress({ egressId });
    last = list[0] ?? null;
    if (!last) {
      await sleep(1500);
      continue;
    }
    const st = last.status;
    if (
      st === EgressStatus.EGRESS_COMPLETE ||
      st === EgressStatus.EGRESS_FAILED ||
      st === EgressStatus.EGRESS_ABORTED ||
      st === EgressStatus.EGRESS_LIMIT_REACHED
    ) {
      return last;
    }
    await sleep(1500);
  }
  return last;
}

/** Stop egress (if still active) and wait for file metadata. */
export async function stopAndFinalizeRecording(input: {
  egressId: string;
  workspaceId: string;
  callId: string;
}): Promise<FinalizedRecording> {
  if (!config.livekit.enabled) {
    return { status: 'skipped', codec: 'ogg', error: 'livekit_not_configured' };
  }

  const storageKey = callRecordingStorageKey(input.workspaceId, input.callId);
  const client = egressClient();

  try {
    const listed = await client.listEgress({ egressId: input.egressId });
    const current = listed[0];
    if (
      current &&
      (current.status === EgressStatus.EGRESS_ACTIVE ||
        current.status === EgressStatus.EGRESS_STARTING)
    ) {
      await client.stopEgress(input.egressId);
    }
  } catch (err) {
    console.warn('[calling] stopEgress', input.egressId, err);
  }

  const info = await waitForEgress(input.egressId);
  if (!info) {
    return { status: 'failed', codec: 'ogg', storageKey, error: 'egress_timeout' };
  }

  if (info.status !== EgressStatus.EGRESS_COMPLETE) {
    return {
      status: 'failed',
      codec: 'ogg',
      storageKey,
      error: info.error || `egress_status_${info.status}`,
    };
  }

  const file = info.fileResults?.[0];
  const durationNs = file?.duration != null ? Number(file.duration) : 0;
  const durationSeconds = durationNs > 0 ? Math.round(durationNs / 1e9) : undefined;
  const fileSize = file?.size != null ? Number(file.size) : undefined;
  const location = file?.location || undefined;
  const startedAt =
    file?.startedAt != null && Number(file.startedAt) > 0
      ? new Date(Number(file.startedAt) / 1e6)
      : undefined;
  const endedAt =
    file?.endedAt != null && Number(file.endedAt) > 0
      ? new Date(Number(file.endedAt) / 1e6)
      : undefined;

  return {
    status: 'ready',
    storageKey,
    location,
    durationSeconds,
    fileSize,
    codec: 'ogg',
    startedAt,
    endedAt,
  };
}
