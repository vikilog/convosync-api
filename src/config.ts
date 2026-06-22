import 'dotenv/config';

const backendPublicUrl = (
  process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || '4000'}`
).replace(/\/$/, '');

export const config = {
  port: parseInt(process.env.API_PORT || process.env.PORT || '4000'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
  /** Public base URL for Meta webhooks and OAuth (dev tunnel / production API host). */
  backendPublicUrl,
  /** Browser origins allowed for API + Socket.io (comma-separated in CORS_ALLOWED_ORIGINS) */
  corsAllowedOrigins: [
    (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3100',
    'http://127.0.0.1:3100',
    ...(process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ].filter((v, i, a) => a.indexOf(v) === i),
  /** In dev, also allow localhost, 127.0.0.1, ngrok, and devtunnels browser origins */
  corsDevRelaxed:
    process.env.NODE_ENV !== 'production' && process.env.CORS_DEV_RELAXED !== 'false',
  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || 'convosync_verify_token',
    configId: process.env.META_CONFIG_ID || '',
    /** Embedded Signup config for WhatsApp Business App coexistence onboarding */
    whatsappConfigId: process.env.META_WHATSAPP_CONFIG || '',
    /** Popup Embedded Signup — must match FB.login redirect_uri exactly */
    embeddedRedirectUri:
      process.env.META_EMBEDDED_REDIRECT_URI ||
      process.env.META_OAUTH_REDIRECT_URI ||
      `${process.env.FRONTEND_URL || 'http://localhost:3000'}/manager`,
    /** Full-page OAuth redirect (optional) */
    oauthRedirectUri:
      process.env.META_OAUTH_REDIRECT_URI ||
      `${process.env.FRONTEND_URL || 'http://localhost:3000'}/manager`,
    /** Instagram DM connect — must match Meta Valid OAuth Redirect URIs and /instagram/callback */
    instagramRedirectUri:
      process.env.META_INSTAGRAM_REDIRECT_URI ||
      `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/instagram/callback`,
    /** Optional server-side redirect (add in Meta if you prefer backend URL) */
    oauthBackendCallbackUri:
      process.env.META_OAUTH_BACKEND_CALLBACK_URI ||
      `${backendPublicUrl}/api/whatsapp/oauth/callback`,
  },
  /** Meta WhatsApp webhook callback (GET verify + POST events). */
  webhookUrl: `${backendPublicUrl}/api/webhook/whatsapp`,
  /** Meta Page webhook callback for Instagram DMs (GET verify + POST events). */
  instagramWebhookUrl: `${backendPublicUrl}/api/webhook/instagram`,
  /** Meta App Dashboard → Deauthorize callback URL */
  metaDeauthorizeUrl: `${backendPublicUrl}/api/meta/deauthorize`,
  /** Meta App Dashboard → Data deletion request URL */
  metaDataDeletionUrl: `${backendPublicUrl}/api/meta/data-deletion`,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.3'),
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '1024', 10),
    timeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10),
  },
  ai: {
    cacheTtlSeconds: parseInt(process.env.AI_CACHE_TTL_SECONDS || '3600', 10),
    maxOutputTokens: parseInt(process.env.AI_MAX_OUTPUT_TOKENS || '500', 10),
    maxHistoryMessages: parseInt(process.env.AI_MAX_HISTORY_MESSAGES || '6', 10),
    idleTimeoutMinutes: parseInt(process.env.AI_IDLE_TIMEOUT_MINUTES || '15', 10),
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    /** Resend dashboard webhook signing secret (whsec_…) for delivery/open/bounce events. */
    resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET || '',
    sharedDomain:
      process.env.CONVOSYNC_SHARED_EMAIL_DOMAIN ||
      process.env.WABIZ_SHARED_EMAIL_DOMAIN ||
      'convosync.io',
    defaultProvider: (process.env.EMAIL_DEFAULT_PROVIDER || 'resend') as
      | 'resend'
      | 'ses'
      | 'sendgrid'
      | 'smtp',
  },
  /** Resend outbound email events (delivered, opened, bounced, …). */
  resendWebhookUrl: `${backendPublicUrl}/api/webhook/resend`,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    oauthRedirectUri:
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/google/callback`,
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    enabled: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    /** Razorpay Subscriptions + UPI Autopay / card mandate. Off = one-time order checkout per billing period. */
    recurringEnabled: process.env.RAZORPAY_RECURRING_ENABLED === 'true',
  },
};
