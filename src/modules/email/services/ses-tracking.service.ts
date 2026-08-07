import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  DescribeConfigurationSetCommand,
  SESClient,
  type EventType,
} from '@aws-sdk/client-ses';
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { config } from '../../../config.js';
import {
  sesConfigSetNameForWorkspace,
  sesSnsTopicNameForWorkspace,
} from '../utils/ses-config-set-name.js';

const EVENT_TYPES: EventType[] = [
  'send',
  'reject',
  'bounce',
  'complaint',
  'delivery',
  'open',
  'click',
];

/**
 * IAM actions ensureSesEventTracking needs:
 * SES config set + event destination (incl. open/click) + SNS topic/subscribe for webhook.
 * Keep frontend EmailPanel policy snippet in sync if this list changes.
 */
export const SES_TRACKING_IAM_ACTIONS = [
  'ses:CreateConfigurationSet',
  'ses:CreateConfigurationSetEventDestination',
  'ses:DescribeConfigurationSet',
  'sns:CreateTopic',
  'sns:Subscribe',
] as const;

export function sesTrackingIamPolicyDocument(): {
  Version: string;
  Statement: Array<{ Effect: string; Action: string[]; Resource: string }>;
} {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [...SES_TRACKING_IAM_ACTIONS],
        Resource: '*',
      },
    ],
  };
}

export type SesTrackingSetupResult =
  | {
      ok: true;
      trackingStatus: 'enabled';
      configurationSetName: string;
      snsTopicArn: string;
    }
  | {
      ok: false;
      trackingStatus: 'error';
      trackingError: string;
      configurationSetName?: string;
      snsTopicArn?: string;
    };

function awsErrorBits(err: unknown): { name: string; message: string; code?: string } {
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name?: string }).name) : '';
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown AWS error');
  const code =
    err && typeof err === 'object' && 'Code' in err
      ? String((err as { Code?: string }).Code)
      : undefined;
  return { name, message, code };
}

function isAlreadyExists(err: unknown): boolean {
  const { name, message, code } = awsErrorBits(err);
  const blob = `${name} ${code ?? ''} ${message}`.toLowerCase();
  return (
    name === 'AlreadyExistsException' ||
    name === 'AlreadyExists' ||
    code === 'AlreadyExists' ||
    blob.includes('already exists') ||
    blob.includes('configuration set already exists')
  );
}

/** Exported for self-check — AWS denial text often repeats the same action twice. */
export function formatTrackingPermissionError(err: unknown): string {
  const { name, message } = awsErrorBits(err);
  const lower = message.toLowerCase();
  // "perform: ses:X … allows the ses:X action" → extract then dedupe.
  // Require PascalCase action (avoids ARN noise like ses:us-east-1 → ses:us).
  const denied = [
    ...new Set(message.match(/\b(?:ses|sns):[A-Z][A-Za-z0-9]+\b/g) ?? []),
  ];

  if (
    name === 'AccessDenied' ||
    name === 'AccessDeniedException' ||
    name === 'UnauthorizedOperation' ||
    lower.includes('not authorized') ||
    lower.includes('access denied')
  ) {
    const required = SES_TRACKING_IAM_ACTIONS.join(', ');
    const deniedNote = denied.length > 0 ? ` (AWS denied: ${denied.join(', ')})` : '';
    return (
      `Tracking not enabled: missing IAM permissions for SES open/click/bounce tracking${deniedNote}. ` +
      `Required: ${required}. Grant these (or broader SES/SNS admin) and save again.`
    );
  }

  return `Tracking not enabled: ${message}`;
}

function clients(creds: { accessKeyId: string; secretAccessKey: string; region: string }) {
  const credentials = {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
  };
  return {
    ses: new SESClient({ region: creds.region, credentials }),
    sns: new SNSClient({ region: creds.region, credentials }),
  };
}

async function ensureTopic(
  sns: SNSClient,
  topicName: string,
  existingArn?: string | null
): Promise<string> {
  if (existingArn?.startsWith('arn:aws:sns:')) return existingArn;
  try {
    const created = await sns.send(new CreateTopicCommand({ Name: topicName }));
    if (!created.TopicArn) throw new Error('SNS CreateTopic returned no TopicArn');
    return created.TopicArn;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // CreateTopic is idempotent by name for same account/region — retry once for ARN.
    const created = await sns.send(new CreateTopicCommand({ Name: topicName }));
    if (!created.TopicArn) throw new Error('SNS topic exists but TopicArn missing');
    return created.TopicArn;
  }
}

async function ensureConfigSet(ses: SESClient, name: string): Promise<void> {
  try {
    await ses.send(new CreateConfigurationSetCommand({ ConfigurationSet: { Name: name } }));
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
}

async function ensureEventDestination(
  ses: SESClient,
  configurationSetName: string,
  topicArn: string
): Promise<void> {
  const destName = 'convosync-sns';
  try {
    const described = await ses.send(
      new DescribeConfigurationSetCommand({
        ConfigurationSetName: configurationSetName,
        ConfigurationSetAttributeNames: ['eventDestinations'],
      })
    );
    const existing = described.EventDestinations?.find((d) => d.Name === destName);
    if (existing?.SNSDestination?.TopicARN === topicArn && existing.Enabled) {
      return;
    }
  } catch {
    // Describe may fail if missing permission — still try create below.
  }

  try {
    await ses.send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: configurationSetName,
        EventDestination: {
          Name: destName,
          Enabled: true,
          MatchingEventTypes: EVENT_TYPES,
          SNSDestination: { TopicARN: topicArn },
        },
      })
    );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
}

/**
 * Create/reuse SES configuration set + SNS topic → webhook for engagement events.
 * Does not throw for permission failures — returns trackingStatus error for UI.
 */
export async function ensureSesEventTracking(input: {
  workspaceId: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  existingConfigurationSetName?: string | null;
  existingSnsTopicArn?: string | null;
}): Promise<SesTrackingSetupResult> {
  const configurationSetName =
    input.existingConfigurationSetName?.trim() ||
    sesConfigSetNameForWorkspace(input.workspaceId);
  const topicName = sesSnsTopicNameForWorkspace(input.workspaceId);
  const webhookUrl = config.sesWebhookUrl;

  if (!webhookUrl.startsWith('https://') && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      trackingStatus: 'error',
      trackingError:
        'Tracking not enabled: BACKEND_PUBLIC_URL must be a public HTTPS URL for SNS callbacks.',
      configurationSetName,
    };
  }

  const { ses, sns } = clients({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    region: input.region,
  });

  try {
    await ensureConfigSet(ses, configurationSetName);
    const snsTopicArn = await ensureTopic(sns, topicName, input.existingSnsTopicArn);
    await sns.send(
      new SubscribeCommand({
        TopicArn: snsTopicArn,
        Protocol: webhookUrl.startsWith('https://') ? 'https' : 'http',
        Endpoint: webhookUrl,
        ReturnSubscriptionArn: true,
      })
    );
    await ensureEventDestination(ses, configurationSetName, snsTopicArn);

    return {
      ok: true,
      trackingStatus: 'enabled',
      configurationSetName,
      snsTopicArn,
    };
  } catch (err) {
    return {
      ok: false,
      trackingStatus: 'error',
      trackingError: formatTrackingPermissionError(err),
      configurationSetName,
    };
  }
}
