import { resolveAPIStyle, detectProvider } from "./providerPresets";
import { responsesRequest, readResponses, responsesAsChat } from "./responsesProtocol";
import { ModelProfile, ToolCall } from "../core/types";
import { parseTokenUsage, TokenUsage } from "./tokenUsage";
import {
  AgentStage,
  resolveProviderCapabilities,
  stageModelOptions,
} from "./providerCapabilities";

export type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: any[];
  protocolRequired?: boolean;
  responseItems?: any[];
};
export type ProviderResponse = {
  usage?: TokenUsage;
  text: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  assistantMessage: ProviderMessage;
  finishReason?: string;
  protocol: "native-tools" | "json-actions";
};

export interface ProviderRequestOptions {
  stage?: AgentStage;
  onReasoningDelta?: (text: string) => void;
  maxTokens?: number;
  onRequestStatus?: (status: { phase: string; attempt: number; stage: string }) => void;
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unsupported-tools"
      | "unsupported-stream"
      | "http"
      | "network"
      | "timeout"
      | "invalid-response",
    public readonly status?: number,
    public readonly responseStarted = false,
  ) {
    super(message);
  }
}

export class OpenAICompatibleProvider {
  private capability = new Map<string, "native-tools" | "json-actions">();

  clearCapability(profileID: string): void {
    for (const key of this.capability.keys())
      if (key.startsWith(`${profileID}\n`)) this.capability.delete(key);
  }

  async complete(
    profile: ModelProfile,
    messages: ProviderMessage[],
    tools: any[],
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderResponse> {
    const capabilityKey = `${profile.id}\n${profile.baseURL}\n${profile.model}\n${profile.provider || "auto"}\n${profile.apiStyle || "auto"}\n${profile.reasoningMode || "auto"}\n${profile.reasoningEnabled}\n${profile.reasoningEffort}`;
    const protocol =
      profile.protocol === "auto"
        ? this.capability.get(capabilityKey) || "native-tools"
        : profile.protocol;
    try {
      const response = await this.requestWithRetry(
        profile,
        messages,
        tools,
        protocol,
        signal,
        onDelta,
        options,
      );
      if (profile.protocol === "auto")
        this.capability.set(capabilityKey, response.protocol);
      return response;
    } catch (error) {
      if (
        profile.protocol === "auto" &&
        protocol === "native-tools" &&
        error instanceof ModelProviderError &&
        error.code === "unsupported-tools"
      ) {
        const response = await this.requestWithRetry(
          profile,
          messages,
          tools,
          "json-actions",
          signal,
          onDelta,
          options,
        );
        this.capability.set(capabilityKey, "json-actions");
        return response;
      }
      throw error;
    }
  }

  private async requestWithRetry(
    profile: ModelProfile,
    messages: ProviderMessage[],
    tools: any[],
    protocol: "native-tools" | "json-actions",
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderResponse> {
    let lastError: unknown;
    let requestProfile = profile;
    let requestMessages = messages;
    let requestOnDelta = onDelta;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw signal.reason || new Error("Model request cancelled");
      options.onRequestStatus?.({
        phase: "started",
        attempt: attempt + 1,
        stage: options.stage || "tool-routing",
      });
      try {
        return await this.request(
          requestProfile,
          requestMessages,
          tools,
          protocol,
          signal,
          requestOnDelta,
          options,
        );
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
        lastError = error;
        if (
          attempt === 0 &&
          protocol === "native-tools" &&
          tools.length &&
          error instanceof ModelProviderError &&
          error.code === "invalid-response" &&
          error.message === "Invalid tool arguments"
        ) {
          requestProfile = { ...profile, streaming: false };
          requestOnDelta = undefined;
          requestMessages = [
            ...messages,
            {
              role: "system",
              content:
                "The previous streamed function.arguments value was not a complete JSON object. Retry the same decision once using exactly one native tool call with a complete, strictly valid JSON arguments object. Do not wrap it in Markdown or emit narrative text.",
            },
          ];
          continue;
        }
        const retriable =
          error instanceof ModelProviderError &&
          (error.code === "network" ||
            error.code === "timeout" ||
            (error.code === "http" &&
              (error.status === 429 || Boolean(error.status && error.status >= 500))));
        if (
          !retriable ||
          (error instanceof ModelProviderError && error.responseStarted)
        )
          throw error;
        if (attempt === 0)
          options.onRequestStatus?.({
            phase: "retrying",
            attempt: 2,
            stage: options.stage || "tool-routing",
          });
      }
    }
    throw lastError;
  }

  private async request(
    profile: ModelProfile,
    messages: ProviderMessage[],
    tools: any[],
    protocol: "native-tools" | "json-actions",
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderResponse> {
    const capabilities = resolveProviderCapabilities(profile);
    const stageOptions = stageModelOptions(profile, options.stage || "tool-routing");
    const preserveEmptyReasoning =
      capabilities.requiresReasoningContentForToolCalls && stageOptions.thinkingEnabled;
    const apiStyle = resolveAPIStyle(profile);
    const requestMessages =
      protocol === "json-actions" ? withJSONProtocol(messages, tools) : messages;
    const body: any = {
      model: profile.model,
      messages:
        apiStyle === "responses"
          ? []
          : protocol === "json-actions"
            ? wireMessages(withJSONProtocol(messages, tools), capabilities, false)
            : wireMessages(messages, capabilities, stageOptions.thinkingEnabled),
      stream: profile.streaming,
    };
    if (options.maxTokens)
      body.max_tokens = Math.max(1, Math.min(2048, options.maxTokens));
    if (
      profile.streaming &&
      ["api.deepseek.com", "api.openai.com"].includes(new URL(profile.baseURL).hostname)
    )
      body.stream_options = { include_usage: true };
    if (protocol === "native-tools" && tools.length) {
      body.tools = tools;
      if (
        capabilities.supportsToolChoice &&
        (!stageOptions.thinkingEnabled || capabilities.supportsToolChoiceInThinking)
      )
        body.tool_choice = "auto";
    }
    if (capabilities.thinkingParameter === "enable-thinking") {
      body.enable_thinking = stageOptions.thinkingEnabled;
    } else if (capabilities.thinkingParameter === "thinking") {
      body.thinking = {
        type: stageOptions.thinkingEnabled ? "enabled" : "disabled",
      };
    }
    if (stageOptions.reasoningEffort)
      body.reasoning_effort = stageOptions.reasoningEffort;
    const requestBody =
      apiStyle === "responses"
        ? responsesRequest(profile, requestMessages, body, protocol)
        : body;
    if (apiStyle === "chat-completions" && detectProvider(profile) === "openai") {
      requestBody.store = false;
      if (body.max_tokens && capabilities.supportsThinking) {
        requestBody.max_completion_tokens = body.max_tokens;
        delete requestBody.max_tokens;
      }
    }
    const controller = new AbortController();
    const timing = requestTimeouts(profile, options.stage || "tool-routing");
    let responseStarted = false;
    let timeoutPhase = "waiting for response";
    let timeout = setTimeout(() => controller.abort("timeout"), timing.initialMs);
    const totalTimeout = setTimeout(() => {
      timeoutPhase = "total duration limit";
      controller.abort("timeout");
    }, timing.totalMs);
    const activity = () => {
      responseStarted = true;
      timeoutPhase = "stream stalled";
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort("timeout"), timing.idleMs);
    };
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const response = await fetch(
        `${profile.baseURL}/${apiStyle === "responses" ? "responses" : "chat/completions"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const text = await response.text();
        if (protocol === "native-tools" && isUnsupportedTools(response.status, text))
          throw new ModelProviderError(
            "Endpoint does not support tools",
            "unsupported-tools",
            response.status,
          );
        if (profile.streaming && isUnsupportedStream(response.status, text))
          throw new ModelProviderError(
            "Endpoint does not support streaming",
            "unsupported-stream",
            response.status,
          );
        const detail = providerErrorDetail(text);
        throw new ModelProviderError(
          `Model request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          "http",
          response.status,
        );
      }
      if (apiStyle === "responses") {
        const payload = await readResponses(
          response,
          profile.streaming,
          onDelta,
          activity,
        );
        const parsed = parseJSONResponse(responsesAsChat(payload), protocol, false);
        // Keep opaque reasoning items with their function calls; existing message budgeting counts them.
        if (protocol === "native-tools")
          parsed.assistantMessage.responseItems = payload.output;
        return parsed;
      }
      if (profile.streaming && response.body)
        return await parseSSE(
          response,
          protocol,
          onDelta,
          options.onReasoningDelta,
          activity,
          preserveEmptyReasoning,
        );
      return parseJSONResponse(await response.json(), protocol, preserveEmptyReasoning);
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted)
        throw new ModelProviderError(
          `Model request timed out (${timeoutPhase}; initial ${timing.initialMs / 1000}s, stream idle ${timing.idleMs / 1000}s, total ${timing.totalMs / 1000}s).`,
          "timeout",
          undefined,
          responseStarted,
        );
      if (signal.aborted) throw signal.reason || error;
      if (isNetworkTransportError(error))
        throw new ModelProviderError(
          "Could not reach the model endpoint after a network transport failure",
          "network",
          undefined,
          responseStarted,
        );
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(totalTimeout);
      signal.removeEventListener("abort", abort);
    }
  }
}

export function requestTimeouts(profile: ModelProfile, stage: AgentStage) {
  const idleMs = Math.max(5000, Math.min(600000, profile.timeoutMs || 45000));
  const thinking =
    profile.reasoningEnabled || stageModelOptions(profile, stage).thinkingEnabled;
  return {
    idleMs,
    initialMs: thinking ? Math.max(180000, idleMs) : idleMs,
    totalMs: Math.max(600000, idleMs * 2),
  };
}

export function describeModelProviderError(error: unknown): string {
  if (!(error instanceof ModelProviderError))
    return error instanceof Error ? error.message : String(error);
  if (error.status === 401)
    return "Authentication failed (HTTP 401). The API key is invalid, expired, truncated, or does not belong to this endpoint.";
  if (error.status === 403)
    return "Access denied (HTTP 403). Check the API key permissions, account access, and selected model.";
  if (error.status === 402)
    return "The model account has insufficient balance or billing access (HTTP 402).";
  if (error.status === 429)
    return "The model service rate limit or quota was exceeded (HTTP 429). Please retry later.";
  if (error.code === "network")
    return "Could not reach the model endpoint after one automatic retry. Check the network, proxy, firewall, or provider status, then retry the message.";
  return error.message;
}

function isNetworkTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /networkerror|failed to fetch|fetch failed|network request failed/i.test(
      error.message,
    )
  );
}

async function parseSSE(
  response: Response,
  protocol: "native-tools" | "json-actions",
  onDelta?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  onActivity?: () => void,
  preserveEmptyReasoning = false,
): Promise<ProviderResponse> {
  const reader = response.body!.getReader() as any;
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoningContent = "";
  let usage: TokenUsage | undefined;
  const toolParts = new Map<number, any>();
  let finishReason: string | undefined;
  const consumeEvent = (event: string) => {
    for (const line of event
      .split(/\r?\n/)
      .filter((entry) => entry.startsWith("data:"))) {
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      usage = parseTokenUsage(chunk.usage) || usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta || {};
      if (typeof delta.content === "string") {
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (typeof delta.reasoning_content === "string") {
        reasoningContent += delta.reasoning_content;
        onReasoningDelta?.(delta.reasoning_content);
      }
      for (const part of delta.tool_calls || []) {
        const current = toolParts.get(part.index) || {
          id: part.id || `tool-${part.index}`,
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.function.name += part.function.name;
        if (part.function?.arguments)
          current.function.arguments += part.function.arguments;
        toolParts.set(part.index, current);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.byteLength) onActivity?.();
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) consumeEvent(event);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer);
  if (protocol === "json-actions") {
    const parsed = parseJSONAction(text);
    return { ...parsed, reasoningContent, usage };
  }
  const toolCalls = [...toolParts.values()].map(parseNativeToolCall);
  const assistantMessage = providerAssistantMessage(
    text,
    reasoningContent,
    toolParts,
    preserveEmptyReasoning,
  );
  return {
    usage,
    text,
    reasoningContent,
    toolCalls,
    assistantMessage,
    finishReason,
    protocol,
  };
}

function parseJSONResponse(
  json: any,
  protocol: "native-tools" | "json-actions",
  preserveEmptyReasoning = false,
): ProviderResponse {
  const message = json?.choices?.[0]?.message;
  if (!message)
    throw new ModelProviderError("Missing model message", "invalid-response");
  const text = typeof message.content === "string" ? message.content : "";
  const reasoningContent =
    typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  if (protocol === "json-actions") {
    const parsed = parseJSONAction(text);
    return { ...parsed, reasoningContent, usage: parseTokenUsage(json.usage) };
  }
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return {
    usage: parseTokenUsage(json.usage),
    text,
    reasoningContent,
    toolCalls: rawToolCalls.map(parseNativeToolCall),
    assistantMessage: {
      role: "assistant",
      content: text,
      ...(reasoningContent || preserveEmptyReasoning
        ? { reasoning_content: reasoningContent }
        : {}),
      ...(rawToolCalls.length ? { tool_calls: rawToolCalls } : {}),
    },
    finishReason: json.choices?.[0]?.finish_reason,
    protocol,
  };
}

function parseNativeToolCall(value: any): ToolCall {
  if (!value?.id || !value.function?.name)
    throw new ModelProviderError("Invalid tool call", "invalid-response");
  let args;
  try {
    const rawArguments = value.function.arguments;
    args =
      rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? rawArguments
        : JSON.parse(rawArguments || "{}");
  } catch {
    throw new ModelProviderError("Invalid tool arguments", "invalid-response");
  }
  return { id: String(value.id), name: String(value.function.name), arguments: args };
}
export function parseJSONAction(text: string): ProviderResponse {
  let parsed: any;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new ModelProviderError(
      "JSON action response was not strict JSON",
      "invalid-response",
    );
  }
  if (parsed?.type === "assistant" && typeof parsed.content === "string")
    return {
      text: parsed.content,
      reasoningContent: "",
      toolCalls: [],
      assistantMessage: { role: "assistant", content: parsed.content },
      protocol: "json-actions",
    };
  if (parsed?.type === "tool_calls" && Array.isArray(parsed.tool_calls))
    return {
      text: "",
      reasoningContent: "",
      toolCalls: parsed.tool_calls
        .map((call: any) => ({
          id: String(call.id || `tool-${Math.random()}`),
          name: String(call.name || ""),
          arguments: call.arguments,
        }))
        .filter((call: ToolCall) => call.name),
      assistantMessage: { role: "assistant", content: "" },
      protocol: "json-actions",
    };
  throw new ModelProviderError("Invalid JSON action shape", "invalid-response");
}

function providerAssistantMessage(
  content: string,
  reasoningContent: string,
  toolParts: Map<number, any>,
  preserveEmptyReasoning = false,
): ProviderMessage {
  const toolCalls = [...toolParts.values()];
  return {
    role: "assistant",
    content,
    // Zero reasoning characters still require an explicit field in DeepSeek history.
    ...(reasoningContent || preserveEmptyReasoning
      ? { reasoning_content: reasoningContent }
      : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function wireMessages(
  messages: ProviderMessage[],
  capabilities: ReturnType<typeof resolveProviderCapabilities>,
  thinkingEnabled: boolean,
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const wire: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
    if (message.tool_calls?.length) {
      wire.tool_calls = message.tool_calls;
      if (capabilities.requiresAssistantContentForToolCalls && wire.content == null)
        wire.content = "";
      if (
        thinkingEnabled &&
        capabilities.requiresReasoningContentForToolCalls &&
        typeof message.reasoning_content !== "string"
      )
        throw new ModelProviderError(
          "Thinking tool-call history is missing reasoning_content",
          "invalid-response",
        );
    }
    if (typeof message.reasoning_content === "string")
      wire.reasoning_content = message.reasoning_content;
    return wire;
  });
}
function withJSONProtocol(
  messages: ProviderMessage[],
  tools: any[],
): ProviderMessage[] {
  return [
    {
      role: "system",
      content: `Return exactly one JSON object, with no markdown or extra text. Either {"type":"assistant","content":"..."} or {"type":"tool_calls","tool_calls":[{"id":"...","name":"...","arguments":{}}]}. Available tools: ${JSON.stringify(tools.map((tool) => tool.function))}`,
    },
    ...messages,
  ];
}
function isUnsupportedTools(status: number, text: string): boolean {
  return (
    [400, 404, 422].includes(status) &&
    /tools?|function[_ .-]?call/i.test(text) &&
    /not support|unsupported|unknown|not allowed|unrecognized/i.test(text)
  );
}
function isUnsupportedStream(status: number, text: string): boolean {
  return (
    [400, 404, 422].includes(status) &&
    /stream|sse/i.test(text) &&
    /not support|unsupported|unknown|not allowed|unrecognized/i.test(text)
  );
}

function providerErrorDetail(text: string): string {
  let value = "";
  try {
    const parsed = JSON.parse(text);
    value = String(parsed?.error?.message || parsed?.message || "");
  } catch {
    value = text;
  }
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_ -]?key|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 300);
}
