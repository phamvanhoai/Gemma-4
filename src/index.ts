interface Env {
  AI: Ai;
  ASSETS: Fetcher;
}

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MAX_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 12_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/api/chat") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    try {
      const body = (await request.json()) as { messages?: Message[] };
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json({ error: "messages must be a non-empty array" }, 400);
      }

      const messages = body.messages.slice(-MAX_MESSAGES).map((message) => ({
        role: message.role,
        content: String(message.content).slice(0, MAX_CONTENT_LENGTH),
      }));

      const valid = messages.every(
        (message) =>
          ["system", "user", "assistant"].includes(message.role) &&
          message.content.trim().length > 0,
      );
      if (!valid) return json({ error: "Invalid message" }, 400);

      const result = await env.AI.run(MODEL, {
        messages,
        max_tokens: 1024,
        temperature: 0.7,
      });

      const output = result as unknown as {
        response?: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      const response = output.response ?? output.choices?.[0]?.message?.content;
      if (!response) return json({ error: "Model returned no text" }, 502);

      return json({ response });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return json({ error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
