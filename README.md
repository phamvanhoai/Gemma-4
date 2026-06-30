# Gemma 4 trên Cloudflare Workers AI

Ứng dụng chat tối giản dùng model `@cf/google/gemma-4-26b-a4b-it` và Workers AI binding.

## Chạy và triển khai

```bash
npm install
npm run dev
npm run deploy
```

Lần triển khai đầu tiên, Wrangler sẽ yêu cầu đăng nhập tài khoản Cloudflare. Không cần API key trong mã nguồn vì Worker gọi model qua AI binding.

Cloudflare Workers AI Free hiện có hạn mức 10.000 neurons mỗi ngày. Khi vượt hạn mức, các yêu cầu AI tiếp theo trong ngày sẽ báo lỗi.
