interface Env { AI: Ai; ASSETS: Fetcher; DB: D1Database }
type Role = "user" | "assistant";
type StoredMessage = { id: number; role: Role; content: string; created_at: string };
type Conversation = { id: string; title: string; created_at: string; updated_at: string };

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const SYSTEM_PROMPT = "Bạn là trợ lý AI hữu ích. Trả lời rõ ràng bằng ngôn ngữ người dùng.";
const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 12_000;
const DAILY_FREE_NEURONS = 10_000;
const INPUT_NEURONS_PER_TOKEN = 0.1 / 0.011 / 1_000;
const OUTPUT_NEURONS_PER_TOKEN = 0.3 / 0.011 / 1_000;

function utcDay() { return new Date().toISOString().slice(0, 10); }
function validId(value: string) { return /^[a-f0-9-]{36}$/.test(value); }
function titleFrom(text: string) { return text.replace(/\s+/g, " ").trim().slice(0, 60) || "Cuộc trò chuyện mới"; }

function sessionId(request: Request): { id: string; isNew: boolean } {
  const match = request.headers.get("Cookie")?.match(/(?:^|;\s*)gemma_session=([a-f0-9-]{36})(?:;|$)/);
  return match ? { id: match[1], isNew: false } : { id: crypto.randomUUID(), isNew: true };
}

function apiJson(data: unknown, session: { id: string; isNew: boolean }, status = 200) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (session.isNew) headers.set("Set-Cookie", `gemma_session=${session.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  return Response.json(data, { status, headers });
}

async function owns(env: Env, conversationId: string, sid: string) {
  return Boolean(await env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND session_id = ?").bind(conversationId, sid).first());
}

async function messages(env: Env, conversationId: string, limit = 100): Promise<StoredMessage[]> {
  const result = await env.DB.prepare(`SELECT id, role, content, created_at FROM (
    SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
  ) ORDER BY id ASC`).bind(conversationId, limit).all<StoredMessage>();
  return result.results;
}

async function ensureLegacyConversation(env: Env, sid: string) {
  const existing = await env.DB.prepare("SELECT id FROM conversations WHERE session_id = ? LIMIT 1").bind(sid).first<{ id: string }>();
  if (existing) return;
  const legacy = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND conversation_id IS NULL").bind(sid).first<{ count: number }>();
  if (!legacy?.count) return;
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO conversations (id, session_id, title) VALUES (?, ?, ?)").bind(id, sid, "Hội thoại trước đây"),
    env.DB.prepare("UPDATE messages SET conversation_id = ? WHERE session_id = ? AND conversation_id IS NULL").bind(id, sid),
  ]);
}

async function usage(env: Env) {
  const row = await env.DB.prepare("SELECT input_tokens, output_tokens, requests FROM daily_usage WHERE day = ?").bind(utcDay()).first<{ input_tokens: number; output_tokens: number; requests: number }>();
  const inputTokens = row?.input_tokens ?? 0, outputTokens = row?.output_tokens ?? 0;
  const neurons = inputTokens * INPUT_NEURONS_PER_TOKEN + outputTokens * OUTPUT_NEURONS_PER_TOKEN;
  return { neurons: Math.round(neurons * 100) / 100, limit: DAILY_FREE_NEURONS, percent: Math.min(100, Math.round(neurons / DAILY_FREE_NEURONS * 10_000) / 100), inputTokens, outputTokens, requests: row?.requests ?? 0, estimated: true };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const session = sessionId(request);

    try {
      if (url.pathname === "/api/usage" && request.method === "GET") return apiJson(await usage(env), session);

      if (url.pathname === "/api/conversations" && request.method === "GET") {
        await ensureLegacyConversation(env, session.id);
        const rows = await env.DB.prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE session_id = ? ORDER BY updated_at DESC").bind(session.id).all<Conversation>();
        return apiJson({ conversations: rows.results }, session);
      }

      if (url.pathname === "/api/conversations" && request.method === "POST") {
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO conversations (id, session_id) VALUES (?, ?)").bind(id, session.id).run();
        return apiJson({ conversation: { id, title: "Cuộc trò chuyện mới" } }, session, 201);
      }

      const conversationMatch = url.pathname.match(/^\/api\/conversations\/([a-f0-9-]{36})(?:\/messages)?$/);
      if (conversationMatch) {
        const id = conversationMatch[1];
        if (!validId(id) || !(await owns(env, id, session.id))) return apiJson({ error: "Không tìm thấy hội thoại" }, session, 404);

        if (url.pathname.endsWith("/messages") && request.method === "GET") return apiJson({ messages: await messages(env, id) }, session);
        if (request.method === "PATCH") {
          const body = (await request.json()) as { title?: unknown };
          const title = titleFrom(String(body.title ?? ""));
          await env.DB.prepare("UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(title, id).run();
          return apiJson({ id, title }, session);
        }
        if (request.method === "DELETE") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
            env.DB.prepare("DELETE FROM conversations WHERE id = ? AND session_id = ?").bind(id, session.id),
          ]);
          return apiJson({ ok: true }, session);
        }
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        const body = (await request.json()) as { content?: unknown; conversationId?: unknown };
        const content = String(body.content ?? "").trim().slice(0, MAX_CONTENT_LENGTH);
        const conversationId = String(body.conversationId ?? "");
        if (!content || !validId(conversationId) || !(await owns(env, conversationId, session.id))) return apiJson({ error: "Tin nhắn hoặc hội thoại không hợp lệ" }, session, 400);

        const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").bind(conversationId).first<{ count: number }>();
        await env.DB.prepare("INSERT INTO messages (session_id, conversation_id, role, content) VALUES (?, ?, 'user', ?)").bind(session.id, conversationId, content).run();
        const title = count?.count === 0 ? titleFrom(content) : undefined;
        await env.DB.prepare("UPDATE conversations SET title = COALESCE(?, title), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(title ?? null, conversationId).run();

        const context = await messages(env, conversationId, MAX_CONTEXT_MESSAGES);
        const result = await env.AI.run(MODEL, { messages: [{ role: "system", content: SYSTEM_PROMPT }, ...context.map(m => ({ role: m.role, content: m.content }))], max_tokens: 1024, temperature: 0.7 });
        const output = result as unknown as { response?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const response = output.response ?? output.choices?.[0]?.message?.content;
        if (!response) return apiJson({ error: "Model không trả về văn bản" }, session, 502);

        await env.DB.prepare("INSERT INTO messages (session_id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)").bind(session.id, conversationId, response).run();
        await env.DB.prepare(`INSERT INTO daily_usage (day, input_tokens, output_tokens, requests) VALUES (?, ?, ?, 1)
          ON CONFLICT(day) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+1`)
          .bind(utcDay(), output.usage?.prompt_tokens ?? 0, output.usage?.completion_tokens ?? 0).run();
        return apiJson({ response, title, usage: await usage(env) }, session);
      }

      return apiJson({ error: "Không tìm thấy API" }, session, 404);
    } catch (error) {
      return apiJson({ error: error instanceof Error ? error.message : "Lỗi không xác định" }, session, 500);
    }
  },
} satisfies ExportedHandler<Env>;
