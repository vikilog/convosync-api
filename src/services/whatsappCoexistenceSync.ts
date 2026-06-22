import axios from 'axios';

const GRAPH_VERSION = 'v21.0';

export type CoexistenceSyncResult = {
  contactsRequestId?: string;
  historyRequestId?: string;
  error?: string;
  details?: string;
};

function formatMetaApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as {
      error?: { message?: string; error_user_msg?: string };
    };
    return data?.error?.error_user_msg || data?.error?.message || err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Meta API request failed';
}

async function requestSmbSync(
  phoneNumberId: string,
  accessToken: string,
  syncType: 'smb_app_state_sync' | 'history'
): Promise<string | undefined> {
  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/smb_app_data`,
    {
      messaging_product: 'whatsapp',
      sync_type: syncType,
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return res.data?.request_id as string | undefined;
}

/**
 * Initiate contact + message history sync after coexistence onboarding.
 * Meta allows each sync type only once per onboarding — failures are logged, not thrown.
 */
export async function triggerCoexistenceDataSync(
  phoneNumberId: string,
  accessToken: string
): Promise<CoexistenceSyncResult> {
  const result: CoexistenceSyncResult = {};

  try {
    result.contactsRequestId = await requestSmbSync(
      phoneNumberId,
      accessToken,
      'smb_app_state_sync'
    );
  } catch (err) {
    result.error = 'Contact sync failed';
    result.details = formatMetaApiError(err);
    return result;
  }

  try {
    result.historyRequestId = await requestSmbSync(phoneNumberId, accessToken, 'history');
  } catch (err) {
    result.error = 'History sync failed';
    result.details = formatMetaApiError(err);
  }

  return result;
}
