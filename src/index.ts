interface Env { AI: Ai; ASSETS: Fetcher; DB: D1Database }
type Role = "user" | "assistant";
type StoredMessage = { id: number; role: Role; content: string; created_at: string };
type Conversation = { id: string; title: string; created_at: string; updated_at: string };
type User = { id: string; email: string; name: string };

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const SYSTEM_PROMPT = "Bạn là trợ lý AI hữu ích. Trả lời rõ ràng bằng ngôn ngữ người dùng.";
const MAX_CONTEXT_MESSAGES = 20, MAX_CONTENT_LENGTH = 12_000, DAILY_FREE_NEURONS = 10_000;
const INPUT_NEURONS_PER_TOKEN = 0.1 / 0.011 / 1_000, OUTPUT_NEURONS_PER_TOKEN = 0.3 / 0.011 / 1_000;

const hex = (data: ArrayBuffer | Uint8Array) => [...new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
const cookie = (request: Request, name: string) => request.headers.get("Cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
const utcDay = () => new Date().toISOString().slice(0, 10);
const validId = (value: string) => /^[a-f0-9-]{36}$/.test(value);
const titleFrom = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 60) || "Cuộc trò chuyện mới";

function browserSession(request: Request) {
  const value = cookie(request, "gemma_session");
  return value && validId(value) ? { id: value, isNew: false } : { id: crypto.randomUUID(), isNew: true };
}

async function sha256(value: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function hashPassword(password: string, saltHex: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256));
}

async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = cookie(request, "gemma_auth");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return await env.DB.prepare(`SELECT u.id, u.email, u.name FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id_hash=? AND s.expires_at > CURRENT_TIMESTAMP`).bind(await sha256(token)).first<User>();
}

function apiJson(data: unknown, sid: { id: string; isNew: boolean }, status = 200, extraCookies: string[] = []) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (sid.isNew) headers.append("Set-Cookie", `gemma_session=${sid.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  extraCookies.forEach(value => headers.append("Set-Cookie", value));
  return Response.json(data, { status, headers });
}

async function createAuthSession(env: Env, userId: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO auth_sessions (id_hash,user_id,expires_at) VALUES (?,?,?)").bind(await sha256(token), userId, expires).run();
  return `gemma_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

async function migrateGuest(env: Env, sid: string, userId: string) {
  await env.DB.prepare("UPDATE conversations SET user_id=? WHERE session_id=? AND user_id IS NULL").bind(userId, sid).run();
}

async function owns(env: Env, conversationId: string, sid: string, user: User | null) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM conversations WHERE id=? AND (user_id=? OR (user_id IS NULL AND session_id=?))`)
    .bind(conversationId, user?.id ?? "", sid).first());
}

async function messages(env: Env, id: string, limit = 100): Promise<StoredMessage[]> {
  return (await env.DB.prepare(`SELECT id,role,content,created_at FROM (SELECT id,role,content,created_at FROM messages
    WHERE conversation_id=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`).bind(id, limit).all<StoredMessage>()).results;
}

async function ensureLegacyConversation(env: Env, sid: string, user: User | null) {
  const existing = await env.DB.prepare("SELECT id FROM conversations WHERE user_id=? OR (user_id IS NULL AND session_id=?) LIMIT 1").bind(user?.id ?? "", sid).first();
  if (existing) return;
  const legacy = await env.DB.prepare("SELECT COUNT(*) count FROM messages WHERE session_id=? AND conversation_id IS NULL").bind(sid).first<{ count: number }>();
  if (!legacy?.count) return;
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO conversations(id,session_id,user_id,title) VALUES(?,?,?,?)").bind(id, sid, user?.id ?? null, "Hội thoại trước đây"),
    env.DB.prepare("UPDATE messages SET conversation_id=? WHERE session_id=? AND conversation_id IS NULL").bind(id, sid),
  ]);
}

async function usage(env: Env) {
  const row = await env.DB.prepare("SELECT input_tokens,output_tokens,requests FROM daily_usage WHERE day=?").bind(utcDay()).first<{ input_tokens:number; output_tokens:number; requests:number }>();
  const input = row?.input_tokens ?? 0, output = row?.output_tokens ?? 0;
  const neurons = input * INPUT_NEURONS_PER_TOKEN + output * OUTPUT_NEURONS_PER_TOKEN;
  return { neurons: Math.round(neurons*100)/100, limit: DAILY_FREE_NEURONS, percent: Math.min(100,Math.round(neurons/DAILY_FREE_NEURONS*10000)/100), requests: row?.requests??0, estimated:true };
}

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  const sid = browserSession(request);
  try {
    if (url.pathname === "/api/auth/me" && request.method === "GET") return apiJson({ user: await currentUser(request, env) }, sid);

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      const body = await request.json() as { email?:unknown; password?:unknown; name?:unknown };
      const email = String(body.email??"").trim().toLowerCase(), password=String(body.password??""), name=String(body.name??"").trim().slice(0,60);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length<8 || !name) return apiJson({error:"Tên, email hoặc mật khẩu chưa hợp lệ (tối thiểu 8 ký tự)."},sid,400);
      if (await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first()) return apiJson({error:"Email này đã được sử dụng."},sid,409);
      const id=crypto.randomUUID(), salt=hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare("INSERT INTO users(id,email,name,password_hash,password_salt) VALUES(?,?,?,?,?)").bind(id,email,name,await hashPassword(password,salt),salt).run();
      await migrateGuest(env,sid.id,id);
      return apiJson({user:{id,email,name}},sid,201,[await createAuthSession(env,id)]);
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const body=await request.json() as {email?:unknown;password?:unknown}; const email=String(body.email??"").trim().toLowerCase(), password=String(body.password??"");
      const record=await env.DB.prepare("SELECT id,email,name,password_hash,password_salt FROM users WHERE email=?").bind(email).first<User & {password_hash:string;password_salt:string}>();
      if (!record || await hashPassword(password,record.password_salt)!==record.password_hash) return apiJson({error:"Email hoặc mật khẩu không đúng."},sid,401);
      await migrateGuest(env,sid.id,record.id);
      return apiJson({user:{id:record.id,email:record.email,name:record.name}},sid,200,[await createAuthSession(env,record.id)]);
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const token=cookie(request,"gemma_auth"); if(token) await env.DB.prepare("DELETE FROM auth_sessions WHERE id_hash=?").bind(await sha256(token)).run();
      return apiJson({ok:true},sid,200,["gemma_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"]);
    }

    const user=await currentUser(request,env);
    if(url.pathname==="/api/usage"&&request.method==="GET") return apiJson(await usage(env),sid);
    if(url.pathname==="/api/conversations"&&request.method==="GET"){
      await ensureLegacyConversation(env,sid.id,user);
      const rows=await env.DB.prepare("SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=? OR (user_id IS NULL AND session_id=?) ORDER BY updated_at DESC").bind(user?.id??"",sid.id).all<Conversation>();
      return apiJson({conversations:rows.results},sid);
    }
    if(url.pathname==="/api/conversations"&&request.method==="POST"){
      const id=crypto.randomUUID(); await env.DB.prepare("INSERT INTO conversations(id,session_id,user_id) VALUES(?,?,?)").bind(id,sid.id,user?.id??null).run();
      return apiJson({conversation:{id,title:"Cuộc trò chuyện mới"}},sid,201);
    }
    const match=url.pathname.match(/^\/api\/conversations\/([a-f0-9-]{36})(?:\/messages)?$/);
    if(match){const id=match[1]; if(!validId(id)||!await owns(env,id,sid.id,user))return apiJson({error:"Không tìm thấy hội thoại"},sid,404);
      if(url.pathname.endsWith("/messages")&&request.method==="GET")return apiJson({messages:await messages(env,id)},sid);
      if(request.method==="PATCH"){const body=await request.json() as {title?:unknown};const title=titleFrom(String(body.title??""));await env.DB.prepare("UPDATE conversations SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(title,id).run();return apiJson({id,title},sid);}
      if(request.method==="DELETE"){await env.DB.batch([env.DB.prepare("DELETE FROM messages WHERE conversation_id=?").bind(id),env.DB.prepare("DELETE FROM conversations WHERE id=?").bind(id)]);return apiJson({ok:true},sid);}
    }
    if(url.pathname==="/api/chat"&&request.method==="POST"){
      const body=await request.json() as {content?:unknown;conversationId?:unknown};const content=String(body.content??"").trim().slice(0,MAX_CONTENT_LENGTH),id=String(body.conversationId??"");
      if(!content||!validId(id)||!await owns(env,id,sid.id,user))return apiJson({error:"Tin nhắn hoặc hội thoại không hợp lệ"},sid,400);
      const count=await env.DB.prepare("SELECT COUNT(*) count FROM messages WHERE conversation_id=?").bind(id).first<{count:number}>();
      await env.DB.prepare("INSERT INTO messages(session_id,conversation_id,role,content) VALUES(?,?,'user',?)").bind(sid.id,id,content).run();
      const title=count?.count===0?titleFrom(content):undefined;await env.DB.prepare("UPDATE conversations SET title=COALESCE(?,title),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(title??null,id).run();
      const context=await messages(env,id,MAX_CONTEXT_MESSAGES);const result=await env.AI.run(MODEL,{messages:[{role:"system",content:SYSTEM_PROMPT},...context.map(m=>({role:m.role,content:m.content}))],max_tokens:1024,temperature:.7});
      const output=result as unknown as {response?:string;choices?:Array<{message?:{content?:string}}>;usage?:{prompt_tokens?:number;completion_tokens?:number}};const response=output.response??output.choices?.[0]?.message?.content;
      if(!response)return apiJson({error:"Model không trả về văn bản"},sid,502);
      await env.DB.prepare("INSERT INTO messages(session_id,conversation_id,role,content) VALUES(?,?,'assistant',?)").bind(sid.id,id,response).run();
      await env.DB.prepare(`INSERT INTO daily_usage(day,input_tokens,output_tokens,requests) VALUES(?,?,?,1) ON CONFLICT(day) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,requests=requests+1`).bind(utcDay(),output.usage?.prompt_tokens??0,output.usage?.completion_tokens??0).run();
      return apiJson({response,title,usage:await usage(env)},sid);
    }
    return apiJson({error:"Không tìm thấy API"},sid,404);
  }catch(error){return apiJson({error:error instanceof Error?error.message:"Lỗi không xác định"},sid,500);}
}} satisfies ExportedHandler<Env>;
