/**
 * OpenTelemetry GenAI semantic convention tracer for LangChain/LangGraph JS.
 *
 * Emits spans following the OpenTelemetry GenAI semantic conventions so that
 * Azure AI Foundry, Application Insights, and other OTEL-compatible backends
 * can render structured agent traces.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentAction, AgentFinish } from '@langchain/core/agents';
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { GenAiAttributes as A, GenAiOperations as Ops } from './attributes.js';

const DEFAULT_PROVIDER = 'azure.ai.openai';
const DEFAULT_TRACER_NAME = 'langchain-azure-otel';
const DEFAULT_MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_MAX_TOOL_CONTENT_LENGTH = 2000;

/**
 * Configuration options for {@link AzureOtelTracer}.
 */
export interface AzureOtelTracerOptions {
  /** Display name for the agent (appears as `gen_ai.agent.name`). */
  name: string;
  /** Optional agent identifier (appears as `gen_ai.agent.id`). */
  id?: string;
  /** Conversation or thread ID (appears as `gen_ai.conversation.id`). */
  conversationId?: string;
  /** Provider name. @default 'azure.ai.openai' */
  providerName?: string;
  /** Record prompt/completion content in span attributes. @default false */
  enableContentRecording?: boolean;
  /** Max characters for recorded message content. @default 1000 */
  maxMessageLength?: number;
  /** Max characters for recorded tool arguments and results. @default 2000 */
  maxToolContentLength?: number;
  /** Custom OTEL tracer name. @default 'langchain-azure-otel' */
  tracerName?: string;
}

/**
 * A LangChain callback handler that emits OpenTelemetry spans following the
 * GenAI semantic conventions. Pass an instance as a callback when invoking
 * a LangChain/LangGraph agent to get structured traces in Azure AI Foundry.
 *
 * @example
 * ```typescript
 * import { AzureOtelTracer } from '@mndr/langchain-azure-otel';
 *
 * const tracer = new AzureOtelTracer({
 *   name: 'My Agent',
 *   conversationId: threadId,
 * });
 *
 * const result = await agent.invoke(
 *   { messages },
 *   { callbacks: [tracer] },
 * );
 * tracer.flush();
 * ```
 */
export class AzureOtelTracer extends BaseCallbackHandler {
  name = 'AzureOtelTracer';

  private readonly tracer;
  private readonly spans = new Map<string, Span>();
  private readonly agentName: string;
  private readonly agentId?: string;
  private readonly conversationId?: string;
  private readonly provider: string;
  private readonly recordContent: boolean;
  private readonly maxMessageLen: number;
  private readonly maxToolLen: number;

  constructor(options: AzureOtelTracerOptions) {
    super({ _awaitHandler: true });
    this.agentName = options.name;
    this.agentId = options.id;
    this.conversationId = options.conversationId;
    this.provider = options.providerName ?? DEFAULT_PROVIDER;
    this.recordContent = options.enableContentRecording ?? false;
    this.maxMessageLen = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    this.maxToolLen = options.maxToolContentLength ?? DEFAULT_MAX_TOOL_CONTENT_LENGTH;
    this.tracer = trace.getTracer(options.tracerName ?? DEFAULT_TRACER_NAME);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** End any remaining open spans (e.g. on stream cancellation). */
  flush(): void {
    for (const [_runId, span] of this.spans) {
      span.setStatus({ code: SpanStatusCode.UNSET });
      span.setAttribute('gen_ai.cancelled', true);
      span.end();
    }
    this.spans.clear();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private startSpan(
    name: string,
    attributes: Record<string, string | number | boolean | undefined>,
    parentRunId?: string,
    kind: SpanKind = SpanKind.INTERNAL,
  ): Span {
    const parentSpan = parentRunId ? this.spans.get(parentRunId) : undefined;
    const ctx = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active();

    const cleanAttrs: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) cleanAttrs[k] = v;
    }

    return this.tracer.startSpan(name, { kind, attributes: cleanAttrs }, ctx);
  }

  private endSpan(runId: string, attributes?: Record<string, string | number | boolean | undefined>): void {
    const span = this.spans.get(runId);
    if (!span) return;

    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== undefined) span.setAttribute(k, v);
      }
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.spans.delete(runId);
  }

  private errorSpan(runId: string, err: Error): void {
    const span = this.spans.get(runId);
    if (!span) return;

    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.recordException(err);
    span.end();
    this.spans.delete(runId);
  }

  private extractModel(serialized: Serialized, extraParams?: Record<string, unknown>): string | undefined {
    const kwargs = (serialized as any).kwargs;
    return kwargs?.model
      ?? kwargs?.model_name
      ?? kwargs?.azure_deployment
      ?? (extraParams?.invocation_params as any)?.model
      ?? (extraParams?.invocation_params as any)?.model_name
      ?? undefined;
  }

  // ---------------------------------------------------------------------------
  // Chain / Agent spans → invoke_agent
  // ---------------------------------------------------------------------------

  handleChainStart(
    chain: Serialized,
    _inputs: Record<string, any>,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    const name = runName ?? chain.id?.[chain.id.length - 1] ?? 'chain';
    const span = this.startSpan(`${Ops.INVOKE_AGENT} ${name}`, {
      [A.OPERATION_NAME]: Ops.INVOKE_AGENT,
      [A.AGENT_NAME]: name,
      [A.AGENT_ID]: this.agentId,
      [A.PROVIDER_NAME]: this.provider,
      [A.CONVERSATION_ID]: this.conversationId,
    }, parentRunId);

    this.spans.set(runId, span);
  }

  handleChainEnd(
    _outputs: Record<string, any>,
    runId: string,
  ): void {
    this.endSpan(runId);
  }

  handleChainError(
    err: Error,
    runId: string,
  ): void {
    this.errorSpan(runId, err);
  }

  // ---------------------------------------------------------------------------
  // Chat model spans → chat
  // ---------------------------------------------------------------------------

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runName?: string,
  ): void {
    const model = this.extractModel(llm, extraParams);
    const kwargs = (llm as any).kwargs ?? {};

    const span = this.startSpan(`${Ops.CHAT} ${model ?? 'unknown'}`, {
      [A.OPERATION_NAME]: Ops.CHAT,
      [A.PROVIDER_NAME]: this.provider,
      [A.REQUEST_MODEL]: model,
      [A.REQUEST_TEMPERATURE]: typeof kwargs.temperature === 'number' ? kwargs.temperature : undefined,
      [A.REQUEST_MAX_TOKENS]: typeof kwargs.max_tokens === 'number' ? kwargs.max_tokens : undefined,
      [A.REQUEST_TOP_P]: typeof kwargs.top_p === 'number' ? kwargs.top_p : undefined,
      [A.CONVERSATION_ID]: this.conversationId,
    }, parentRunId, SpanKind.CLIENT);

    if (this.recordContent && messages.length > 0) {
      try {
        const formatted = messages[0].map((m) => ({
          role: m._getType?.() ?? 'unknown',
          content: typeof m.content === 'string' ? m.content.slice(0, this.maxMessageLen) : '[complex]',
        }));
        span.setAttribute(A.INPUT_MESSAGES, JSON.stringify(formatted));
      } catch { /* ignore serialization errors */ }
    }

    this.spans.set(runId, span);
  }

  handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const model = this.extractModel(llm, extraParams);
    const span = this.startSpan(`${Ops.CHAT} ${model ?? 'unknown'}`, {
      [A.OPERATION_NAME]: Ops.CHAT,
      [A.PROVIDER_NAME]: this.provider,
      [A.REQUEST_MODEL]: model,
      [A.CONVERSATION_ID]: this.conversationId,
    }, parentRunId, SpanKind.CLIENT);

    this.spans.set(runId, span);
  }

  handleLLMEnd(
    output: LLMResult,
    runId: string,
  ): void {
    const llmOutput = output.llmOutput as Record<string, any> | undefined;
    const tokenUsage = llmOutput?.tokenUsage ?? llmOutput?.usage ?? {};
    const genInfo = (output.generations?.[0]?.[0] as any)?.generationInfo;
    const responseModel = genInfo?.model_name ?? genInfo?.model ?? llmOutput?.model_name ?? undefined;

    const attrs: Record<string, string | number | boolean | undefined> = {
      [A.RESPONSE_MODEL]: responseModel,
      [A.USAGE_INPUT_TOKENS]: tokenUsage.promptTokens ?? tokenUsage.prompt_tokens,
      [A.USAGE_OUTPUT_TOKENS]: tokenUsage.completionTokens ?? tokenUsage.completion_tokens,
    };

    if (this.recordContent && output.generations?.[0]?.[0]) {
      try {
        const text = output.generations[0][0].text;
        if (text) {
          attrs[A.OUTPUT_MESSAGES] = JSON.stringify([{ role: 'assistant', content: text.slice(0, this.maxMessageLen) }]);
        }
      } catch { /* ignore */ }
    }

    this.endSpan(runId, attrs);
  }

  handleLLMError(
    err: Error,
    runId: string,
  ): void {
    this.errorSpan(runId, err);
  }

  // ---------------------------------------------------------------------------
  // Tool spans → execute_tool
  // ---------------------------------------------------------------------------

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): void {
    const name = runName ?? tool.id?.[tool.id.length - 1] ?? 'tool';

    const attrs: Record<string, string | number | boolean | undefined> = {
      [A.OPERATION_NAME]: Ops.EXECUTE_TOOL,
      [A.TOOL_NAME]: name,
      [A.TOOL_CALL_ID]: toolCallId,
    };

    if (this.recordContent && input) {
      attrs[A.TOOL_CALL_ARGUMENTS] = typeof input === 'string'
        ? input.slice(0, this.maxToolLen)
        : JSON.stringify(input).slice(0, this.maxToolLen);
    }

    const span = this.startSpan(`${Ops.EXECUTE_TOOL} ${name}`, attrs, parentRunId, SpanKind.CLIENT);
    this.spans.set(runId, span);
  }

  handleToolEnd(
    output: any,
    runId: string,
  ): void {
    const attrs: Record<string, string | number | boolean | undefined> = {};

    if (this.recordContent && output != null) {
      const str = typeof output === 'string' ? output : JSON.stringify(output);
      attrs[A.TOOL_CALL_RESULT] = str.slice(0, this.maxToolLen);
    }

    this.endSpan(runId, attrs);
  }

  handleToolError(
    err: Error,
    runId: string,
  ): void {
    this.errorSpan(runId, err);
  }

  // ---------------------------------------------------------------------------
  // Agent action/finish — informational
  // ---------------------------------------------------------------------------

  handleAgentAction(
    action: AgentAction,
    runId: string,
  ): void {
    const span = this.spans.get(runId);
    if (span) {
      span.setAttribute('gen_ai.agent.action.tool', action.tool);
    }
  }

  handleAgentEnd(
    _action: AgentFinish,
    _runId: string,
  ): void {
    // Agent finish is informational — the chain end will close the span
  }
}
