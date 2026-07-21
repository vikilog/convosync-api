/**
 * OpenTelemetry bootstrap — MUST load before app code.
 *
 * Loaded via:
 *   tsx/node --import ./src/instrumentation.ts  (dev: package.json "dev")
 *   node --import ./dist/instrumentation.js     (prod: package.json "start")
 *
 * Opt-in: OTEL_ENABLED=true
 * Endpoint: OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendRoot, '..');
// Root first (shared OTEL_*), then backend/.env can override
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(backendRoot, '.env') });

function otelEnabled(): boolean {
  const disabled = (process.env.OTEL_SDK_DISABLED || '').toLowerCase();
  if (disabled === '1' || disabled === 'true' || disabled === 'yes' || disabled === 'on') {
    return false;
  }
  const enabled = (process.env.OTEL_ENABLED || '').toLowerCase();
  return enabled === '1' || enabled === 'true' || enabled === 'yes' || enabled === 'on';
}

if (!otelEnabled()) {
  console.log('[otel] skipped (set OTEL_ENABLED=true when collector is running)');
} else {
  const rawEndpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(
    /\/$/,
    ''
  );
  const otlpBase = rawEndpoint.replace(/\/v1\/(traces|metrics|logs)$/, '');

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'convosync-backend',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${otlpBase}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${otlpBase}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${otlpBase}/v1/logs` }),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noise — leave Fastify/HTTP/undici/Prisma on
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Default OTel→Pino only ships `msg` as body ("request completed").
        // We emit full JSON lines ourselves (see pino-otel-json-stream + index.ts).
        '@opentelemetry/instrumentation-pino': {
          disableLogSending: true,
        },
      }),
    ],
  });

  sdk.start();

  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } catch (err) {
      console.error('[otel] shutdown failed', err);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[otel] NodeSDK started → ${otlpBase} (service=convosync-backend)`);
}
