/** Shared tracer for manual ConvoSync spans (llm.generate, retrieval.pinecone, …). */
import { trace } from '@opentelemetry/api';

export const otelTracer = trace.getTracer('convosync-backend', '1.0.0');
