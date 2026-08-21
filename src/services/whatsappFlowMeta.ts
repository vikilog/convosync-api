const GRAPH = 'https://graph.facebook.com/v21.0';

export class MetaFlowApiError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'MetaFlowApiError';
  }
}

async function metaFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const errText = await res.text();
    let message = errText || `Meta API error (${res.status})`;
    try {
      const parsed = JSON.parse(errText) as { error?: { message?: string; error_user_msg?: string } };
      message = parsed.error?.error_user_msg || parsed.error?.message || message;
    } catch {
      // errText wasn't JSON — keep the raw text as the message.
    }
    throw new MetaFlowApiError(message, errText);
  }
  return res.json() as Promise<T>;
}

/** Create an empty draft Flow on Meta — flow JSON is uploaded separately as an asset. */
export async function createMetaFlow(
  accessToken: string,
  wabaId: string,
  name: string,
  categories: string[]
): Promise<{ metaFlowId: string }> {
  const data = await metaFetch<{ id?: string }>(`${GRAPH}/${wabaId}/flows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, categories: categories.length ? categories : ['OTHER'] }),
  });
  if (!data.id) throw new MetaFlowApiError('Meta did not return a flow id');
  return { metaFlowId: data.id };
}

/** Upload/replace the Flow JSON asset. Flow must be in DRAFT status on Meta's side. */
export async function uploadMetaFlowJson(
  accessToken: string,
  metaFlowId: string,
  flowJson: unknown
): Promise<{ success: boolean; validationErrors: unknown[] }> {
  const form = new FormData();
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(flowJson), 'utf-8'));
  const blob = new Blob([bytes], { type: 'application/json' });
  form.append('file', blob, 'flow.json');
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');

  const res = await fetch(`${GRAPH}/${metaFlowId}/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const text = await res.text();
  let parsed: { success?: boolean; validation_errors?: unknown[] } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave parsed empty — fall through to the ok-check below
  }
  if (!res.ok) {
    throw new MetaFlowApiError(
      (parsed as { error?: { message?: string } }).error?.message || text || 'Failed to upload flow JSON',
      text
    );
  }
  return {
    success: parsed.success ?? true,
    validationErrors: parsed.validation_errors ?? [],
  };
}

/** Publish a draft Flow — irreversible on Meta's side; the flow JSON can no longer be edited after this. */
export async function publishMetaFlow(accessToken: string, metaFlowId: string): Promise<void> {
  await metaFetch(`${GRAPH}/${metaFlowId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function getMetaFlowStatus(
  accessToken: string,
  metaFlowId: string
): Promise<{ status: string; validationErrors: unknown[] }> {
  const data = await metaFetch<{ status?: string; validation_errors?: unknown[] }>(
    `${GRAPH}/${metaFlowId}?fields=status,validation_errors`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return { status: data.status || 'UNKNOWN', validationErrors: data.validation_errors ?? [] };
}
