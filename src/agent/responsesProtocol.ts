import type { ModelProfile } from "../core/types";
import { ModelProviderError, type ProviderMessage } from "./modelProvider";
import { detectProvider } from "./providerPresets";

export function responsesRequest(
  profile: ModelProfile,
  messages: ProviderMessage[],
  chatBody: any,
  protocol: "native-tools" | "json-actions",
): any {
  const input: any[] = [];
  for (const message of messages) {
    if (protocol === "json-actions") {
      input.push({
        role: message.role === "tool" ? "user" : message.role,
        content:
          message.role === "tool"
            ? "Tool result " + message.tool_call_id + ": " + message.content
            : message.content || JSON.stringify(message.tool_calls || []),
      });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
    } else if (message.responseItems?.length) {
      input.push(...message.responseItems);
    } else {
      if (message.content || !message.tool_calls?.length)
        input.push({ role: message.role, content: message.content });
      for (const call of message.tool_calls || [])
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
    }
  }
  return {
    model: profile.model,
    input,
    stream: profile.streaming,
    store: false,
    ...(detectProvider(profile) === "openai"
      ? { include: ["reasoning.encrypted_content"] }
      : {}),
    ...(chatBody.max_tokens ? { max_output_tokens: chatBody.max_tokens } : {}),
    ...(chatBody.reasoning_effort
      ? { reasoning: { effort: chatBody.reasoning_effort } }
      : {}),
    ...(chatBody.thinking ? { thinking: chatBody.thinking } : {}),
    ...(chatBody.enable_thinking !== undefined
      ? { enable_thinking: chatBody.enable_thinking }
      : {}),
    ...(chatBody.tools?.length
      ? {
          tools: chatBody.tools.map((tool: any) => ({
            type: "function",
            ...tool.function,
            strict: false,
          })),
          tool_choice: "auto",
        }
      : {}),
  };
}

export async function readResponses(
  response: Response,
  streaming: boolean,
  onDelta?: (text: string) => void,
  onActivity?: () => void,
): Promise<any> {
  if (!streaming || !response.body) return validateResponse(await response.json());
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: any;
  const consume = (event: string) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new ModelProviderError(
        "Invalid Responses event JSON",
        "invalid-response",
        undefined,
        true,
      );
    }
    if (
      parsed.type === "response.output_text.delta" &&
      typeof parsed.delta === "string"
    )
      onDelta?.(parsed.delta);
    if (
      ["response.completed", "response.incomplete", "response.failed"].includes(
        parsed.type,
      )
    )
      completed = validateResponse(parsed.response);
    if (parsed.type === "error")
      throw new ModelProviderError(
        "Responses stream reported an error",
        "invalid-response",
        undefined,
        true,
      );
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let split: RegExpExecArray | null;
      while ((split = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, split.index));
        buffer = buffer.slice(split.index + split[0].length);
      }
      if (completed) return completed;
    }
    buffer += decoder.decode(new Uint8Array());
    if (buffer.trim()) consume(buffer);
    if (!completed)
      throw new ModelProviderError(
        "Responses stream ended before completion",
        "invalid-response",
        undefined,
        true,
      );
    return completed;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function validateResponse(value: any): any {
  if (!value || value.status !== "completed" || !Array.isArray(value.output))
    throw new ModelProviderError(
      "Responses did not complete; check the model, output limit or API support",
      "invalid-response",
    );
  return value;
}

export function responsesAsChat(value: any): any {
  const tool_calls: any[] = [];
  const text: string[] = [];
  for (const item of value.output) {
    if (item.type === "function_call") {
      if (!item.call_id || !item.name || typeof item.arguments !== "string")
        throw new ModelProviderError(
          "Invalid Responses function call",
          "invalid-response",
        );
      tool_calls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" && typeof part.text === "string")
          text.push(part.text);
        if (part.type === "refusal" && typeof part.refusal === "string")
          text.push(part.refusal);
      }
    }
  }
  return {
    choices: [
      {
        message: { role: "assistant", content: text.join(""), tool_calls },
        finish_reason: tool_calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: value.usage
      ? {
          prompt_tokens: value.usage.input_tokens,
          completion_tokens: value.usage.output_tokens,
          total_tokens: value.usage.total_tokens,
        }
      : undefined,
  };
}
