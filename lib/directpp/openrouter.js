// Minimal OpenRouter client for the serverless Direct++ flow.
// Mirrors engine/tsengine/llm/client.py: JSON mode, lenient parsing, and the
// same message shapes (file part for PDFs, image_url parts for images).

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

export function apiKey() {
  return process.env.OPENROUTER_API_KEY || process.env.TSE_OPENROUTER_API_KEY || "";
}

export function fileMessage(text, pdf, images) {
  // pdf: {filename, dataUrl} | null;  images: array of data URLs
  const parts = [{ type: "text", text }];
  if (pdf) {
    parts.push({
      type: "file",
      file: { filename: pdf.filename, file_data: pdf.dataUrl },
    });
  }
  for (const url of images || []) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  return { role: "user", content: parts };
}

// One chat call. Returns {data, text, usage} — data is the leniently-parsed
// JSON object or null. Throws only on network-level failure after retry.
export async function chatJson(model, messages, { maxTokens = 8000, timeoutMs = 180000 } = {}) {
  const body = {
    model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(OR_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://timesheet-intelligence.local",
          "X-Title": "Timesheet Intelligence (serverless)",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload) {
    const msg = payload?.error?.message || `HTTP ${res.status}`;
    return { data: null, text: "", usage: null, error: msg };
  }
  const text = payload?.choices?.[0]?.message?.content || "";
  const usage = payload?.usage || null;
  return { data: loadsLenient(text), text, usage, error: null };
}

// Tolerant JSON extraction: strip code fences, find the outermost object.
export function loadsLenient(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {}
  }
  return null;
}
