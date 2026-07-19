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
    cacheTtlSeconds: parseInt(
      process.env.CACHE_TTL_SECONDS || process.env.AI_CACHE_TTL_SECONDS || '86400',
      10
    ),
    maxOutputTokens: parseInt(process.env.AI_MAX_OUTPUT_TOKENS || '500', 10),
    maxHistoryMessages: parseInt(process.env.AI_MAX_HISTORY_MESSAGES || '6', 10),
    idleTimeoutMinutes: parseInt(process.env.AI_IDLE_TIMEOUT_MINUTES || '15', 10),
    /** Pinecone score >= this → return KB answer with no LLM. */
    similarityHighThreshold: parseFloat(process.env.SIMILARITY_HIGH_THRESHOLD || '0.85'),
    /** Pinecone score >= this (and < high) → RAG LLM; below → full LLM or escalate. */
    similarityLowThreshold: parseFloat(process.env.SIMILARITY_LOW_THRESHOLD || '0.60'),
    hybridTopK: parseInt(process.env.HYBRID_TOP_K || '3', 10),
    escalateOnLowScore: process.env.AI_ESCALATE_ON_LOW_SCORE === 'true',
  },
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY || '',
    indexName: process.env.PINECONE_INDEX || 'text-embedding-3-small',
    /** Serverless index host URL from Pinecone console (optional if index resolves by name). */
    host: (process.env.PINECONE_HOST || '').replace(/\/$/, ''),
    /** pinecone = Pinecone Inference (llama-text-embed-v2). openai = OpenAI embeddings API. */
    embeddingProvider: (process.env.PINECONE_EMBEDDING_PROVIDER === 'openai'
      ? 'openai'
      : 'pinecone') as 'openai' | 'pinecone',
    embeddingModel:
      process.env.PINECONE_EMBEDDING_MODEL ||
      (process.env.PINECONE_EMBEDDING_PROVIDER === 'openai'
        ? 'text-embedding-3-small'
        : 'llama-text-embed-v2'),
    /** Must match Pinecone index dimension. llama-text-embed-v2 defaults to 1024 unless set. */
    embeddingDimension: parseInt(process.env.PINECONE_EMBEDDING_DIMENSION || '2048', 10),
    topK: parseInt(process.env.PINECONE_TOP_K || '5', 10),
    enabled: Boolean(process.env.PINECONE_API_KEY?.trim()),
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
    /** Razorpay Subscriptions + UPI Autopay / card mandate. Auto-on when plan IDs are configured. */
    recurringEnabled:
      process.env.RAZORPAY_RECURRING_ENABLED === 'true' ||
      ['STARTER', 'GROWTH', 'PRO'].some((slug) => {
        const monthly = process.env[`RAZORPAY_PLAN_${slug}_MONTHLY`]?.trim();
        const annual = process.env[`RAZORPAY_PLAN_${slug}_ANNUAL`]?.trim();
        return (
          (monthly?.startsWith('plan_') && monthly.length > 5) ||
          (annual?.startsWith('plan_') && annual.length > 5)
        );
      }),
  },
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    region: process.env.AWS_REGION || 'ap-south-1',
    bucketName: process.env.AWS_BUCKET_NAME || '',
    s3Prefix: (process.env.AWS_S3_PREFIX || 'uploads').replace(/\/$/, ''),
    /** Optional override, e.g. https://convosync.s3.ap-south-1.amazonaws.com */
    s3Endpoint: (process.env.AWS_S3_ENDPOINT || '').replace(/\/$/, ''),
    enabled: Boolean(
      process.env.AWS_BUCKET_NAME &&
        process.env.AWS_ACCESS_KEY_ID &&
        process.env.AWS_SECRET_ACCESS_KEY
    ),
  },
  livekit: {
    url: (process.env.LIVEKIT_URL || '').replace(/\/$/, ''),
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    /** Ring timeout before status → missed */
    ringTimeoutSeconds: parseInt(process.env.LIVEKIT_RING_TIMEOUT_SECONDS || '45', 10),
    /** After accept, max wait for LiveKit join before miss/fail */
    acceptJoinGraceSeconds: parseInt(process.env.LIVEKIT_ACCEPT_JOIN_GRACE_SECONDS || '45', 10),
    /** Access token TTL (seconds) */
    tokenTtlSeconds: parseInt(process.env.LIVEKIT_TOKEN_TTL_SECONDS || '600', 10),
    /** Customer guest link TTL (seconds) — default 2h */
    guestTokenTtlSeconds: parseInt(process.env.CALL_GUEST_TOKEN_TTL_SECONDS || '7200', 10),
    enabled: Boolean(
      process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
    ),
  },
  /**
   * Pipecat voice AI agent service (joins LiveKit rooms for AI-handled calls).
   * Local: http://127.0.0.1:8092 — prod: dedicated host.
   */
  voiceAgent: {
    serviceUrl: (process.env.VOICE_AGENT_SERVICE_URL || 'http://127.0.0.1:8092').replace(
      /\/$/,
      ''
    ),
    internalSecret: process.env.CONVOSYNC_INTERNAL_SECRET || '',
    startTimeoutMs: parseInt(process.env.VOICE_AGENT_START_TIMEOUT_MS || '4000', 10),
  },
  /** Post-call Faster-Whisper STT (optional — skipped if python/deps missing) */
  callStt: {
    enabled: process.env.CALL_STT_ENABLED !== 'false',
    pythonBin: process.env.CALL_STT_PYTHON || 'python3',
    /**
     * When set (e.g. http://127.0.0.1:8091), POST /transcribe to the STT HTTP service.
     * Local `npm run dev` starts that service; prod points at a separate STT host.
     * Empty = spawn local `stt/transcribe.py` CLI.
     */
    url: (process.env.CALL_STT_URL || '').replace(/\/$/, ''),
    /** Override path to stt/transcribe.py (default: <repo>/stt/transcribe.py) */
    scriptPath: process.env.CALL_STT_SCRIPT || '',
    /** medium is a good India default; large-v3 better but slower/heavier */
    model: process.env.CALL_STT_MODEL || 'medium',
    /** auto | hi | en | bn | ta | te | mr | gu | kn | ml | pa | ur | … */
    language: process.env.CALL_STT_LANGUAGE || 'auto',
    /**
     * When language=auto and detection is weak / English-biased (Hinglish),
     * retry with this code. Default hi for India.
     */
    preferLanguage: process.env.CALL_STT_PREFER_LANGUAGE || 'hi',
    /** Optional Whisper initial prompt; empty = built-in Hinglish prompt when prefer=hi */
    initialPrompt: process.env.CALL_STT_INITIAL_PROMPT || '',
    device: process.env.CALL_STT_DEVICE || 'auto', // auto | cpu | cuda
    computeType: process.env.CALL_STT_COMPUTE_TYPE || 'default',
  },
  /**
   * Customer Insight pipeline (Claude) — Phase 1 infra; LLM prompt is Phase 2.
   * CONTACT_INSIGHT_LLM_ENABLED stays false until prompt lands.
   */
  contactInsight: {
    enabled: process.env.CONTACT_INSIGHT_ENABLED !== 'false',
    /** Phase 2 gate — when false, worker builds context then skips Claude */
    llmEnabled: process.env.CONTACT_INSIGHT_LLM_ENABLED === 'true',
    modelVersion: process.env.CONTACT_INSIGHT_MODEL_VERSION || 'insight-v2',
    minInteractions: parseInt(process.env.CONTACT_INSIGHT_MIN_INTERACTIONS || '3', 10),
    /** Below this, user message adds an explicit low-confidence note for the model */
    lowSignalThreshold: parseInt(process.env.CONTACT_INSIGHT_LOW_SIGNAL_THRESHOLD || '5', 10),
    /** Don't recompute the same contact more often than this */
    minGapHours: parseInt(process.env.CONTACT_INSIGHT_MIN_GAP_HOURS || '6', 10),
    maxConversations: parseInt(process.env.CONTACT_INSIGHT_MAX_CONVERSATIONS || '10', 10),
    lookbackDays: parseInt(process.env.CONTACT_INSIGHT_LOOKBACK_DAYS || '90', 10),
    maxCallTranscripts: parseInt(process.env.CONTACT_INSIGHT_MAX_CALLS || '10', 10),
    churnRiskTagThreshold: parseInt(process.env.CONTACT_INSIGHT_CHURN_TAG_THRESHOLD || '70', 10),
    purchaseIntentTagThreshold: parseInt(
      process.env.CONTACT_INSIGHT_PURCHASE_TAG_THRESHOLD || '70',
      10
    ),
    churnRiskTag: process.env.CONTACT_INSIGHT_CHURN_TAG || 'high_churn_risk',
    purchaseIntentTag: process.env.CONTACT_INSIGHT_PURCHASE_TAG || 'hot_lead',
    /** Nightly scan hour in local process TZ (default 2am) */
    nightlyHour: parseInt(process.env.CONTACT_INSIGHT_NIGHTLY_HOUR || '2', 10),
  },
};
