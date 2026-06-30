"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, FileText, LogIn, LogOut, Menu, MessageSquarePlus, MoreHorizontal, Paperclip, Pencil, Send, Sparkles, Trash2, UserRound, X } from "lucide-react";

type Conversation = { id: string; title: string; created_at?: string; updated_at?: string };
type Message = { id?: number; role: "user" | "assistant"; content: string };
type Usage = { neurons: number; limit: number; percent: number; requests: number; estimated: boolean };
type User = { id: string; email: string; name: string };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "Yêu cầu thất bại");
  return data;
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [attachment, setAttachment] = useState<File | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = conversations.find((item) => item.id === currentId);
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const selectConversation = useCallback(async (id: string) => {
    setCurrentId(id); setSidebarOpen(false); setMenuId(null);
    const data = await api<{ messages: Message[] }>(`/api/conversations/${id}/messages`);
    setMessages(data.messages);
  }, []);

  const startDraft = useCallback(() => {
    setCurrentId(null); setMessages([]); setSidebarOpen(false); setMenuId(null); setInput("");
  }, []);

  useEffect(() => {
    Promise.all([api<{ conversations: Conversation[] }>("/api/conversations"), api<Usage>("/api/usage"), api<{user:User|null}>("/api/auth/me")])
      .then(async ([conversationData, usageData, authData]) => {
        setUsage(usageData); setUser(authData.user); setConversations(conversationData.conversations);
        if (conversationData.conversations[0]) await selectConversation(conversationData.conversations[0].id);
        else startDraft();
      }).catch((error) => setMessages([{ role: "assistant", content: `Lỗi: ${error.message}` }]));
  }, [selectConversation, startDraft]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if ((!content && !attachment) || loading) return;
    const selectedFile = attachment;
    setInput(""); setLoading(true);
    setAttachment(null);
    setMessages((items) => [...items, { role: "user", content: `${content || "Hãy phân tích và tóm tắt file này."}${selectedFile ? `\n\n📎 ${selectedFile.name}` : ""}` }]);
    try {
      let conversationId = currentId;
      if (!conversationId) {
        const created = await api<{ conversation: Conversation }>("/api/conversations", { method: "POST" });
        conversationId = created.conversation.id;
        setCurrentId(conversationId);
        setConversations((items) => [created.conversation, ...items]);
      }
      let request: RequestInit;
      if (selectedFile) { const formData=new FormData(); formData.set("content",content); formData.set("conversationId",conversationId); formData.set("file",selectedFile); request={method:"POST",body:formData}; }
      else request={method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({content,conversationId})};
      const data = await api<{ response: string; title?: string; truncated?: boolean; usage: Usage }>("/api/chat", request);
      setMessages((items) => [...items, { role: "assistant", content: data.response + (data.truncated ? "\n\n> Phản hồi đã đạt giới hạn độ dài. Hãy yêu cầu **tiếp tục** để xem phần còn lại." : "") }]);
      setUsage(data.usage);
      if (data.title) setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, title: data.title! } : item));
    } catch (error) {
      setMessages((items) => [...items, { role: "assistant", content: `Lỗi: ${error instanceof Error ? error.message : "Không xác định"}` }]);
    } finally { setLoading(false); }
  }

  async function renameConversation(item: Conversation) {
    const nextTitle = prompt("Đổi tên cuộc trò chuyện", item.title)?.trim();
    if (!nextTitle) return;
    const result = await api<{ title: string }>(`/api/conversations/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle }) });
    setConversations((items) => items.map((entry) => entry.id === item.id ? { ...entry, title: result.title } : entry)); setMenuId(null);
  }

  async function deleteConversation(item: Conversation) {
    if (!confirm(`Xóa “${item.title}”?`)) return;
    await api(`/api/conversations/${item.id}`, { method: "DELETE" });
    const remaining = conversations.filter((entry) => entry.id !== item.id); setConversations(remaining); setMenuId(null);
    if (currentId === item.id) remaining[0] ? await selectConversation(remaining[0].id) : startDraft();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setAuthError("");
    const form = new FormData(event.currentTarget);
    try {
      const data = await api<{user:User}>(`/api/auth/${authMode}`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({name:form.get("name"),email:form.get("email"),password:form.get("password")}) });
      setUser(data.user); setAuthOpen(false);
      const refreshed=await api<{conversations:Conversation[]}>("/api/conversations"); setConversations(refreshed.conversations);
    } catch(error) { setAuthError(error instanceof Error ? error.message : "Không thể xác thực"); }
    finally { setAuthBusy(false); }
  }

  async function logout() {
    await api("/api/auth/logout",{method:"POST"}); setUser(null); setConversations([]); startDraft();
  }

  return <div className="shell">
    {sidebarOpen && <button className="backdrop" aria-label="Đóng menu" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Sparkles size={18}/></div><strong>Gemma 4</strong><button className="icon mobile-close" onClick={() => setSidebarOpen(false)}><X size={20}/></button></div>
      <button className="new-chat" onClick={startDraft}><MessageSquarePlus size={18}/>Cuộc trò chuyện mới</button>
      <nav className="conversation-list">
        <span className="section-label">Gần đây</span>
        {conversations.map((item) => <div className={`conversation ${item.id === currentId ? "active" : ""}`} key={item.id}>
          <button className="conversation-name" onClick={() => selectConversation(item.id)}>{item.title}</button>
          <button className="more" onClick={() => setMenuId(menuId === item.id ? null : item.id)}><MoreHorizontal size={17}/></button>
          {menuId === item.id && <div className="context-menu"><button onClick={() => renameConversation(item)}><Pencil size={15}/>Đổi tên</button><button className="danger" onClick={() => deleteConversation(item)}><Trash2 size={15}/>Xóa</button></div>}
        </div>)}
      </nav>
      <div className="sidebar-footer"><div className="quota"><div className="quota-head"><span>Quota hôm nay</span><span>{usage?.percent ?? 0}%</span></div><div className="progress"><span style={{ width: `${usage?.percent ?? 0}%` }}/></div><p>{usage ? `${usage.neurons.toLocaleString("vi-VN")} / ${usage.limit.toLocaleString("vi-VN")} neurons` : "Đang tải…"}</p><small>Ước tính · đặt lại 00:00 UTC</small></div>
      {user ? <div className="account"><div className="account-avatar">{user.name.charAt(0).toUpperCase()}</div><div><strong>{user.name}</strong><span>{user.email}</span></div><button className="icon" title="Đăng xuất" onClick={logout}><LogOut size={17}/></button></div> : <button className="login-button" onClick={()=>{setAuthMode("login");setAuthError("");setAuthOpen(true)}}><LogIn size={17}/>Đăng nhập để đồng bộ</button>}</div>
    </aside>
    <main className="main">
      <header><button className="icon hamburger" onClick={() => setSidebarOpen(true)}><Menu size={21}/></button><div><h1>{current?.title || "Cuộc trò chuyện mới"}</h1><span><i/>Gemma 4 · Cloudflare AI</span></div></header>
      <section className="messages">
        {!messages.length && <div className="welcome"><div className="welcome-icon"><Bot size={30}/></div><h2>Hôm nay mình giúp gì cho bạn?</h2><p>Gemma 4 có thể trò chuyện, phân tích và hỗ trợ lập trình bằng tiếng Việt.</p></div>}
        {messages.map((message, index) => <article className={`message-row ${message.role}`} key={index}>
          {message.role === "assistant" && <div className="avatar"><Sparkles size={16}/></div>}
          <div className="bubble">{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : message.content}</div>
        </article>)}
        {loading && <article className="message-row assistant"><div className="avatar"><Sparkles size={16}/></div><div className="thinking"><i/><i/><i/></div></article>}
        <div ref={bottomRef}/>
      </section>
      <div className="composer-wrap">{attachment&&<div className="attachment-chip"><FileText size={16}/><span><strong>{attachment.name}</strong><small>{(attachment.size/1024/1024).toFixed(2)} MB</small></span><button type="button" onClick={()=>setAttachment(null)}><X size={15}/></button></div>}<form className="composer" onSubmit={submit}><input ref={fileRef} className="file-input" type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.html,.xml,.docx,.xlsx,.pptx" onChange={e=>{const file=e.target.files?.[0];if(file&&file.size<=10*1024*1024)setAttachment(file);else if(file)alert("File tối đa 10 MB");e.target.value=""}}/><button className="attach-button" type="button" title="Đính kèm ảnh hoặc tài liệu" onClick={()=>fileRef.current?.click()}><Paperclip size={19}/></button><textarea value={input} onChange={(e)=>setInput(e.target.value)} onKeyDown={keyDown} placeholder="Nhắn tin hoặc đính kèm file…" rows={1}/><button className="send-button" disabled={(!input.trim()&&!attachment)||loading} aria-label="Gửi"><Send size={18}/></button></form><p><Check size={12}/>Hỗ trợ ảnh, PDF, Word, Excel và file văn bản · tối đa 10 MB</p></div>
    </main>
    {authOpen && <div className="auth-overlay" onMouseDown={()=>setAuthOpen(false)}><div className="auth-card" onMouseDown={e=>e.stopPropagation()}><button className="icon auth-close" onClick={()=>setAuthOpen(false)}><X size={20}/></button><div className="auth-logo"><UserRound size={23}/></div><h2>{authMode==="login"?"Chào mừng trở lại":"Tạo tài khoản"}</h2><p>{authMode==="login"?"Đồng bộ hội thoại trên mọi thiết bị":"Lịch sử chat hiện tại sẽ được giữ lại"}</p><form onSubmit={authenticate}>{authMode==="register"&&<label>Tên hiển thị<input name="name" required maxLength={60} autoComplete="name"/></label>}<label>Email<input name="email" type="email" required autoComplete="email"/></label><label>Mật khẩu<input name="password" type="password" required minLength={8} autoComplete={authMode==="login"?"current-password":"new-password"}/></label>{authError&&<div className="auth-error">{authError}</div>}<button className="auth-submit" disabled={authBusy}>{authBusy?"Đang xử lý…":authMode==="login"?"Đăng nhập":"Đăng ký"}</button></form><button className="auth-switch" onClick={()=>{setAuthMode(authMode==="login"?"register":"login");setAuthError("")}}>{authMode==="login"?"Chưa có tài khoản? Đăng ký":"Đã có tài khoản? Đăng nhập"}</button></div></div>}
  </div>;
}
