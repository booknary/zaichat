import { isAllowedBaseURL } from "../utils/prefs";

/** No credentials or provider error bodies are retained in the catalog. */
export async function fetchModelCatalog(
  baseURL: string,
  apiKey: string,
): Promise<string[]> {
  const base = baseURL.trim().replace(/\/+$/, "");
  if (!isAllowedBaseURL(base)) throw new Error("请使用 HTTPS，或本机 HTTP 地址。");
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("API 地址不能包含凭据、查询参数或片段。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${base}/models`, {
      headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`获取模型列表失败（HTTP ${response.status}），可继续手动填写。`);
    const json: any = await response.json();
    if (!Array.isArray(json?.data))
      throw new Error("提供商未返回兼容的模型列表，可手动填写。");
    return [
      ...new Set<string>(
        json.data.flatMap((entry: any) =>
          typeof entry?.id === "string" && entry.id.trim() && entry.id.length <= 256
            ? [entry.id.trim()]
            : [],
        ),
      ),
    ]
      .sort()
      .slice(0, 2000);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("获取模型列表超时，请重试。");
    if (
      error instanceof Error &&
      /^(获取模型列表失败|提供商未返回)/.test(error.message)
    )
      throw error;
    throw new Error("无法获取模型列表，请检查地址、网络及密钥；仍可手动填写。");
  } finally {
    clearTimeout(timer);
  }
}
