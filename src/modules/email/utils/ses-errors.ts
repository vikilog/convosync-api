/** Map AWS SES / credential errors to admin-readable messages. */
export function formatSesSendError(err: unknown): string {
  const raw =
    err && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string'
      ? (err as Error).message
      : String(err ?? 'Unknown SES error');
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name?: string }).name) : '';
  const code =
    err && typeof err === 'object' && '$metadata' in err
      ? String(
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? ''
        )
      : '';
  const lower = raw.toLowerCase();

  if (
    name === 'InvalidClientTokenId' ||
    name === 'SignatureDoesNotMatch' ||
    name === 'UnrecognizedClientException' ||
    lower.includes('security token') ||
    lower.includes('the security token included in the request is invalid') ||
    lower.includes('signature')
  ) {
    return 'Invalid AWS credentials. Check the Access Key ID and Secret Access Key.';
  }

  if (
    name === 'MessageRejected' ||
    lower.includes('email address is not verified') ||
    lower.includes('not verified')
  ) {
    if (lower.includes('sandbox') || lower.includes('not authorized to send')) {
      return (
        'SES rejected this send. New AWS accounts start in the SES Sandbox and can only send ' +
        'to verified addresses until Production Access is approved (this is controlled by AWS).'
      );
    }
    return (
      'Sender or recipient is not verified in AWS SES. Verify the identity in SES, or request ' +
      'Production Access if you are still in the SES Sandbox.'
    );
  }

  if (lower.includes('sandbox') || lower.includes('sending paused')) {
    return (
      'AWS SES Sandbox or sending pause blocked this email. Request Production Access in the ' +
      'AWS SES console (outside ConvoSync control).'
    );
  }

  if (name === 'AccessDenied' || code === '403' || lower.includes('access denied')) {
    return (
      'AWS denied SES access. Ensure this IAM user can call ses:GetSendQuota, ' +
      'ses:ListIdentities, ses:GetIdentityVerificationAttributes, and ses:SendEmail / ses:SendRawEmail.'
    );
  }

  if (lower.includes('could not resolve') || lower.includes('region')) {
    return `Invalid AWS region or network error: ${raw}`;
  }

  return raw;
}
