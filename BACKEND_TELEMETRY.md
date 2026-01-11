# Backend Telemetry Endpoint

Para implementar telemetria de forma segura, você precisa criar um endpoint no backend do Kodus que recebe eventos do CLI e encaminha para o PostHog.

## Por que usar um proxy?

**Segurança:**
- ✅ API key do PostHog fica no servidor (não exposta)
- ✅ Previne abuso (rate limiting, validação)
- ✅ Pode adicionar autenticação/validação extra

**Flexibilidade:**
- ✅ Pode mudar de PostHog para outro provider sem atualizar CLI
- ✅ Pode enriquecer eventos com dados do servidor
- ✅ Pode filtrar/descartar eventos inválidos

## Endpoint: POST /v1/telemetry/events

### Request

```json
{
  "distinctId": "anon_abc123",
  "event": "review_completed",
  "properties": {
    "files_analyzed": 5,
    "issues_found": 12,
    "critical_issues": 2,
    "duration_ms": 3450,
    "cli_version": "0.1.0",
    "platform": "darwin",
    "node_version": "v20.0.0",
    "timestamp": "2025-01-03T10:30:00Z"
  }
}
```

### Response

```json
{
  "success": true
}
```

## Implementação (Node.js/Express)

```typescript
import express from 'express';
import { PostHog } from 'posthog-node';

const app = express();
app.use(express.json());

// Initialize PostHog on the server (API key is secure)
const posthog = new PostHog(
  process.env.POSTHOG_API_KEY!, // Server-side, never exposed
  {
    host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
  }
);

// Telemetry endpoint
app.post('/v1/telemetry/events', async (req, res) => {
  try {
    const { distinctId, event, properties } = req.body;

    // Validation
    if (!distinctId || !event) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Optional: Rate limiting per IP
    // Optional: Validate event schema
    // Optional: Enrich with server-side data

    // Forward to PostHog
    posthog.capture({
      distinctId,
      event,
      properties: {
        ...properties,
        // Add server-side enrichment
        server_timestamp: new Date().toISOString(),
        ip_country: req.headers['cf-ipcountry'], // Cloudflare example
      },
    });

    // Respond immediately (don't wait for PostHog)
    res.json({ success: true });

    // Flush in background
    await posthog.flush();
  } catch (error) {
    console.error('Telemetry error:', error);
    // Always return success to CLI (best-effort telemetry)
    res.json({ success: true });
  }
});

// Shutdown gracefully
process.on('SIGTERM', async () => {
  await posthog.shutdown();
  process.exit(0);
});

app.listen(3000, () => {
  console.log('Telemetry API listening on port 3000');
});
```

## Implementação (Python/FastAPI)

```python
from fastapi import FastAPI, Request
from posthog import Posthog
import os
from datetime import datetime

app = FastAPI()

# Initialize PostHog (API key is secure on server)
posthog = Posthog(
    project_api_key=os.getenv('POSTHOG_API_KEY'),
    host=os.getenv('POSTHOG_HOST', 'https://app.posthog.com')
)

@app.post("/v1/telemetry/events")
async def track_event(request: Request):
    try:
        data = await request.json()
        distinct_id = data.get('distinctId')
        event = data.get('event')
        properties = data.get('properties', {})

        # Validation
        if not distinct_id or not event:
            return {"error": "Missing required fields"}

        # Optional: Rate limiting
        # Optional: Event validation

        # Enrich with server data
        properties['server_timestamp'] = datetime.utcnow().isoformat()

        # Forward to PostHog
        posthog.capture(
            distinct_id=distinct_id,
            event=event,
            properties=properties
        )

        return {"success": True}

    except Exception as e:
        print(f"Telemetry error: {e}")
        # Always return success (best-effort)
        return {"success": True}

@app.on_event("shutdown")
async def shutdown():
    posthog.shutdown()
```

## Rate Limiting (Opcional)

Para prevenir abuso:

```typescript
import rateLimit from 'express-rate-limit';

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 events per minute per IP
  message: 'Too many telemetry events',
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/v1/telemetry/events', telemetryLimiter, async (req, res) => {
  // ... handle event
});
```

## Validação de Eventos (Opcional)

```typescript
// Whitelist de eventos válidos
const VALID_EVENTS = [
  'review_started',
  'review_completed',
  'review_failed',
  'auth_login_success',
  'auth_signup_success',
  'interactive_mode_used',
  'fix_mode_used',
];

app.post('/v1/telemetry/events', async (req, res) => {
  const { event } = req.body;

  if (!VALID_EVENTS.includes(event)) {
    console.warn(`Invalid event: ${event}`);
    return res.status(400).json({ error: 'Invalid event' });
  }

  // ... forward to PostHog
});
```

## Monitoramento

Adicione logs/metrics para monitorar:

```typescript
// Count events per type
const eventCounts = new Map<string, number>();

app.post('/v1/telemetry/events', async (req, res) => {
  const { event } = req.body;

  // Increment counter
  eventCounts.set(event, (eventCounts.get(event) || 0) + 1);

  // Log periodically
  if (Math.random() < 0.01) { // 1% sampling
    console.log('Event counts:', Object.fromEntries(eventCounts));
  }

  // ... forward to PostHog
});
```

## Deploy

**Environment Variables:**
```bash
POSTHOG_API_KEY=phc_your_actual_key_here
POSTHOG_HOST=https://app.posthog.com
```

**Docker:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENV POSTHOG_API_KEY=${POSTHOG_API_KEY}
CMD ["node", "server.js"]
```

## Testes

```bash
# Test endpoint
curl -X POST https://api.kodus.io/v1/telemetry/events \
  -H "Content-Type: application/json" \
  -d '{
    "distinctId": "test_user",
    "event": "test_event",
    "properties": {
      "test": true
    }
  }'
```

## Benefícios desta Arquitetura

1. **Segurança**: API key nunca exposta ao usuário
2. **Controle**: Você decide quais eventos aceitar
3. **Performance**: Rate limiting previne abuso
4. **Flexibilidade**: Pode mudar de analytics provider sem atualizar CLI
5. **Enriquecimento**: Adiciona dados server-side (geo, etc)
