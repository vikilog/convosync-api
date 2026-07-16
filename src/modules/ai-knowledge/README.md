# AI Knowledge Sync Module

Read-only connector that pulls salon data from an **external MongoDB** database,
normalizes it for an AI receptionist, and stores snapshots in ConvoSync (`ai_knowledge` table).

## Folder structure

```
modules/ai-knowledge/
├── config/
│   └── collection-map.ts       # External collection name candidates + venue field names
├── controllers/
│   └── ai-knowledge.controller.ts
├── dto/
│   └── ai-knowledge.dto.ts     # Zod validation
├── embeddings/
│   └── embedding.provider.ts   # Future vector DB hook (no-op today)
├── repositories/
│   └── ai-knowledge.repository.ts
├── routes/
│   └── ai-knowledge.routes.ts
├── services/
│   ├── ai-knowledge.service.ts # Orchestration
│   ├── mongo-sync.service.ts   # Read-only dynamic MongoDB connection
│   └── normalizer.service.ts   # Raw docs → NormalizedSalonKnowledge
├── types/
│   ├── ai-knowledge.types.ts
│   └── normalized.types.ts
├── utils/
│   └── field-utils.ts
└── container.ts                # DI wiring
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai-knowledge/config` | Saved venue + masked connection string |
| PUT | `/api/ai-knowledge/config` | Persist venue / connection settings |
| POST | `/api/ai-knowledge/sync` | Sync from external MongoDB |
| GET | `/api/ai-knowledge/:venueId` | Latest normalized snapshot |

## Agent knowledge base (Pinecone)

AI agents store knowledge items (documents, Q&A, URLs) in Postgres. When Pinecone is configured,
items are chunked, embedded with OpenAI, and upserted into a per-workspace namespace.

Env: `PINECONE_API_KEY`, `PINECONE_INDEX`, optional `PINECONE_HOST`, `OPENAI_EMBEDDING_MODEL`.

Reindex existing items: `POST /api/agents/:id/knowledge/reindex`

## Future: salon Mongo sync embeddings

1. Call `buildKnowledgeChunks()` after normalize (already invoked in sync).
2. Implement `EmbeddingProvider.embed()`.
3. Upsert vectors into Pinecone / pgvector / Atlas Vector Search.

External MongoDB is **never written to** — all reads use `MongoClient` with read preference `secondaryPreferred`.
