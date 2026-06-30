import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gemma 4",
  description: "Trợ lý AI Gemma 4 chạy trên Cloudflare Workers AI",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body>{children}</body></html>;
}
