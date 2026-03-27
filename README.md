# @mndr/langchain-azure-otel

OpenTelemetry GenAI tracing for LangChain/LangGraph JS with Azure AI Foundry and Application Insights.

Microsoft's [`langchain-azure-ai`](https://pypi.org/project/langchain-azure-ai/) provides agent tracing for Python. **This package is the Node.js/TypeScript equivalent** — a LangChain callback handler that emits spans following the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/), so Azure AI Foundry's trace viewer can render structured agent traces.

## Install

```bash
npm install @mndr/langchain-azure-otel
```

Peer dependencies (bring your own):

```bash
npm install @langchain/core @opentelemetry/api
```

## Quick Start — Azure Monitor

```typescript
import { useAzureMonitor } from '@azure/monitor-opentelemetry';
import { AzureOtelTracer } from '@mndr/langchain-azure-otel';

// 1. Initialize Azure Monitor (once, at startup)
useAzureMonitor({
  azureMonitorExporterOptions: {
    connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
  },
});

// 2. Create a tracer for each agent invocation
const tracer = new AzureOtelTracer({
  name: 'My Agent',
  conversationId: threadId,
  enableContentRecording: true,
});

// 3. Pass as callback to your LangChain/LangGraph agent
const result = await agent.invoke(
  { messages: [{ role: 'user', content: 'Hello' }] },
  { callbacks: [tracer] },
);

// 4. Flush on completion (important for streaming/cancellation)
tracer.flush();
```

Traces appear in **Azure AI Foundry → Observability → Traces** within 2–5 minutes.

## Quick Start — Any OTEL Backend

Works with any OpenTelemetry-compatible backend (Jaeger, Grafana Tempo, Honeycomb, etc.):

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AzureOtelTracer } from '@mndr/langchain-azure-otel';

// Set up your OTEL provider
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
provider.register();

// Use the tracer as a LangChain callback
const tracer = new AzureOtelTracer({ name: 'My Agent' });
await agent.invoke(input, { callbacks: [tracer] });
tracer.flush();
```

## With LangGraph Streaming

```typescript
const tracer = new AzureOtelTracer({
  name: 'My Agent',
  conversationId: threadId,
});

const stream = agent.streamEvents(
  { messages },
  { version: 'v2', callbacks: [tracer] },
);

for await (const event of stream) {
  // Process events...
}

tracer.flush(); // End any remaining spans
```

## API Reference

### `AzureOtelTracer(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | *required* | Agent display name (`gen_ai.agent.name`) |
| `id` | `string` | — | Agent identifier (`gen_ai.agent.id`) |
| `conversationId` | `string` | — | Thread/conversation ID (`gen_ai.conversation.id`) |
| `providerName` | `string` | `'azure.ai.openai'` | LLM provider name (`gen_ai.provider.name`) |
| `enableContentRecording` | `boolean` | `false` | Include prompt/completion content in spans |
| `maxMessageLength` | `number` | `1000` | Max characters for recorded message content |
| `maxToolContentLength` | `number` | `2000` | Max characters for tool arguments/results |
| `tracerName` | `string` | `'langchain-azure-otel'` | OTEL tracer name |

### `tracer.flush()`

Ends any remaining open spans (e.g., on stream cancellation). Always call after the agent invocation completes.

## What Gets Traced

| LangChain Callback | GenAI Span | Span Kind | Key Attributes |
|---|---|---|---|
| `handleChainStart/End` | `invoke_agent {name}` | `INTERNAL` | `gen_ai.agent.name`, `gen_ai.conversation.id` |
| `handleChatModelStart/End` | `chat {model}` | `CLIENT` | `gen_ai.request.model`, `gen_ai.usage.*` |
| `handleLLMStart/End` | `chat {model}` | `CLIENT` | `gen_ai.request.model` |
| `handleToolStart/End` | `execute_tool {name}` | `CLIENT` | `gen_ai.tool.name`, `gen_ai.tool.call.id` |

## Azure AI Foundry Setup

1. Create an [Application Insights](https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview) resource
2. Connect it to your [Foundry project](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup)
3. Use `@azure/monitor-opentelemetry` to export spans to Application Insights
4. Use this package as a LangChain callback — traces appear in Foundry's Observability → Traces view

## Compatibility

| Dependency | Supported Versions |
|---|---|
| `@langchain/core` | `>=0.2.0` |
| `@opentelemetry/api` | `^1.3.0` |
| Node.js | `>=18` |
| LangGraph JS | `>=0.2.0` |

## Semantic Conventions

This package exports the GenAI attribute constants for use in custom instrumentation:

```typescript
import { GenAiAttributes, GenAiOperations } from '@mndr/langchain-azure-otel';

console.log(GenAiAttributes.AGENT_NAME); // 'gen_ai.agent.name'
console.log(GenAiOperations.CHAT);       // 'chat'
```

## License

MIT
