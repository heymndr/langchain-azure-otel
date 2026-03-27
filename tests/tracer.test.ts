import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AzureOtelTracer } from '../src/tracer.js';
import { GenAiAttributes as A, GenAiOperations as Ops } from '../src/attributes.js';

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

function createTracer(overrides?: Partial<ConstructorParameters<typeof AzureOtelTracer>[0]>) {
  return new AzureOtelTracer({
    name: 'Test Agent',
    conversationId: 'thread-123',
    ...overrides,
  });
}

const mockSerialized = (name: string) => ({
  lc: 1,
  type: 'constructor' as const,
  id: ['langchain', name],
  kwargs: {},
});

const mockLlmSerialized = () => ({
  lc: 1,
  type: 'constructor' as const,
  id: ['langchain', 'AzureChatOpenAI'],
  kwargs: { model: 'gpt-4o', temperature: 0.3 },
});

describe('AzureOtelTracer', () => {
  describe('agent spans (handleChainStart/End)', () => {
    it('creates an invoke_agent span with correct attributes', () => {
      const tracer = createTracer();
      tracer.handleChainStart(mockSerialized('StateGraph'), {}, 'run-1', undefined, [], {}, undefined, 'ads_agent');
      tracer.handleChainEnd({}, 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.name).toBe('invoke_agent ads_agent');
      expect(span.kind).toBe(SpanKind.INTERNAL);
      expect(span.attributes[A.OPERATION_NAME]).toBe(Ops.INVOKE_AGENT);
      expect(span.attributes[A.AGENT_NAME]).toBe('ads_agent');
      expect(span.attributes[A.CONVERSATION_ID]).toBe('thread-123');
      expect(span.attributes[A.PROVIDER_NAME]).toBe('azure.ai.openai');
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('uses chain id as fallback name', () => {
      const tracer = createTracer();
      tracer.handleChainStart(mockSerialized('MyChain'), {}, 'run-1');
      tracer.handleChainEnd({}, 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[A.AGENT_NAME]).toBe('MyChain');
    });

    it('sets agent.id when provided', () => {
      const tracer = createTracer({ id: 'agent-42' });
      tracer.handleChainStart(mockSerialized('chain'), {}, 'run-1');
      tracer.handleChainEnd({}, 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[A.AGENT_ID]).toBe('agent-42');
    });
  });

  describe('LLM spans (handleChatModelStart/End)', () => {
    it('creates a chat span with SpanKind.CLIENT and model attributes', () => {
      const tracer = createTracer();
      tracer.handleChatModelStart(mockLlmSerialized(), [[]], 'run-1', undefined, {});
      tracer.handleLLMEnd({
        generations: [[{ text: 'Hello', generationInfo: { model_name: 'gpt-4o' } }]],
        llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      }, 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.name).toBe('chat gpt-4o');
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes[A.OPERATION_NAME]).toBe(Ops.CHAT);
      expect(span.attributes[A.REQUEST_MODEL]).toBe('gpt-4o');
      expect(span.attributes[A.REQUEST_TEMPERATURE]).toBe(0.3);
      expect(span.attributes[A.RESPONSE_MODEL]).toBe('gpt-4o');
      expect(span.attributes[A.USAGE_INPUT_TOKENS]).toBe(10);
      expect(span.attributes[A.USAGE_OUTPUT_TOKENS]).toBe(5);
    });

    it('handles handleLLMStart as fallback', () => {
      const tracer = createTracer();
      tracer.handleLLMStart(mockLlmSerialized(), ['prompt'], 'run-1');
      tracer.handleLLMEnd({ generations: [[{ text: 'ok' }]], llmOutput: {} }, 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].kind).toBe(SpanKind.CLIENT);
      expect(spans[0].attributes[A.OPERATION_NAME]).toBe(Ops.CHAT);
    });
  });

  describe('tool spans (handleToolStart/End)', () => {
    it('creates an execute_tool span with SpanKind.CLIENT', () => {
      const tracer = createTracer();
      tracer.handleToolStart(mockSerialized('get_weather'), '{"city":"NYC"}', 'run-1', undefined, [], {}, 'get_weather', 'call-abc');
      tracer.handleToolEnd('Sunny in NYC', 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.name).toBe('execute_tool get_weather');
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes[A.OPERATION_NAME]).toBe(Ops.EXECUTE_TOOL);
      expect(span.attributes[A.TOOL_NAME]).toBe('get_weather');
      expect(span.attributes[A.TOOL_CALL_ID]).toBe('call-abc');
    });
  });

  describe('parent-child hierarchy', () => {
    it('child spans reference parent via context', () => {
      const tracer = createTracer();
      tracer.handleChainStart(mockSerialized('graph'), {}, 'run-parent');
      tracer.handleChatModelStart(mockLlmSerialized(), [[]], 'run-child', 'run-parent', {});
      tracer.handleLLMEnd({ generations: [[{ text: '' }]], llmOutput: {} }, 'run-child');
      tracer.handleChainEnd({}, 'run-parent');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);

      const childSpan = spans.find(s => s.name.startsWith('chat'))! as any;
      const parentSpan = spans.find(s => s.name.startsWith('invoke_agent'))!;

      expect(childSpan.parentSpanContext.spanId).toBe(parentSpan.spanContext().spanId);
    });
  });

  describe('error handling', () => {
    it('handleChainError sets ERROR status and records exception', () => {
      const tracer = createTracer();
      tracer.handleChainStart(mockSerialized('chain'), {}, 'run-1');
      tracer.handleChainError(new Error('boom'), 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('boom');
      expect(spans[0].events).toHaveLength(1);
      expect(spans[0].events[0].name).toBe('exception');
    });

    it('handleLLMError sets ERROR status', () => {
      const tracer = createTracer();
      tracer.handleChatModelStart(mockLlmSerialized(), [[]], 'run-1');
      tracer.handleLLMError(new Error('timeout'), 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    });

    it('handleToolError sets ERROR status', () => {
      const tracer = createTracer();
      tracer.handleToolStart(mockSerialized('tool'), '', 'run-1');
      tracer.handleToolError(new Error('fail'), 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe('content recording', () => {
    it('does not record content when disabled', () => {
      const tracer = createTracer({ enableContentRecording: false });
      tracer.handleToolStart(mockSerialized('tool'), '{"secret":"data"}', 'run-1', undefined, [], {}, 'tool', 'call-1');
      tracer.handleToolEnd('secret result', 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[A.TOOL_CALL_ARGUMENTS]).toBeUndefined();
      expect(spans[0].attributes[A.TOOL_CALL_RESULT]).toBeUndefined();
    });

    it('records and truncates content when enabled', () => {
      const tracer = createTracer({ enableContentRecording: true, maxToolContentLength: 10 });
      tracer.handleToolStart(mockSerialized('tool'), 'a very long argument string', 'run-1', undefined, [], {}, 'tool', 'call-1');
      tracer.handleToolEnd('a very long result string', 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[A.TOOL_CALL_ARGUMENTS]).toBe('a very lon');
      expect(spans[0].attributes[A.TOOL_CALL_RESULT]).toBe('a very lon');
    });
  });

  describe('flush', () => {
    it('ends remaining open spans with cancelled attribute', () => {
      const tracer = createTracer();
      tracer.handleChainStart(mockSerialized('chain'), {}, 'run-1');
      tracer.handleChatModelStart(mockLlmSerialized(), [[]], 'run-2', 'run-1');

      // Neither end nor error called — simulate stream cancellation
      tracer.flush();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      for (const span of spans) {
        expect(span.attributes['gen_ai.cancelled']).toBe(true);
        expect(span.status.code).toBe(SpanStatusCode.UNSET);
      }
    });
  });

  describe('custom provider', () => {
    it('uses custom provider name', () => {
      const tracer = createTracer({ providerName: 'openai' });
      tracer.handleChainStart(mockSerialized('chain'), {}, 'run-1');
      tracer.handleChainEnd({}, 'run-1');

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[A.PROVIDER_NAME]).toBe('openai');
    });
  });

  describe('no-op safety', () => {
    it('does not throw when no spans exist for a runId', () => {
      const tracer = createTracer();
      expect(() => {
        tracer.handleChainEnd({}, 'nonexistent');
        tracer.handleLLMError(new Error('x'), 'nonexistent');
        tracer.handleToolEnd('x', 'nonexistent');
        tracer.flush();
      }).not.toThrow();
    });
  });
});
