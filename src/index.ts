import { TelegramAdapter, BaleAdapter, MessageDeduplicator } from "./channels/channel-adapter";
import { AdminAuthService, AdminManagementService } from "./admin/admin-service";

export interface AppServerConfig {
  port?: number;
  adminSecret?: string;
}

export function createAppServer(config: AppServerConfig = {}) {
  const port = config.port ?? Number(process.env.PORT || 3000);
  const deduplicator = new MessageDeduplicator();
  const telegramAdapter = new TelegramAdapter(deduplicator);
  const baleAdapter = new BaleAdapter(deduplicator);
  const adminAuth = new AdminAuthService(config.adminSecret ?? process.env.ADMIN_WEBVIEW_SECRET ?? "default_dev_secret");
  const adminMgmt = new AdminManagementService();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Healthcheck endpoint for Docker & Container monitoring
      if (url.pathname === "/healthz" && req.method === "GET") {
        return Response.json({
          status: "healthy",
          timestamp: new Date().toISOString(),
          service: "rezervasiyon-bot",
          uptime: process.uptime(),
        });
      }

      // Admin WebView Health
      if (url.pathname === "/admin/health" && req.method === "GET") {
        return Response.json({
          status: "healthy",
          adminService: "ready",
        });
      }

      // Telegram webhook mock/test handler
      if (url.pathname === "/webhook/telegram" && req.method === "POST") {
        try {
          const body = await req.json();
          const normalized = telegramAdapter.normalizeInbound(body, "TRAVELER");
          return Response.json({ status: "received", messageId: normalized.messageId });
        } catch (err: any) {
          return Response.json({ error: err.message || "Invalid payload" }, { status: 400 });
        }
      }

      // Bale webhook mock/test handler
      if (url.pathname === "/webhook/bale" && req.method === "POST") {
        try {
          const body = await req.json();
          const normalized = baleAdapter.normalizeInbound(body, "TRAVELER");
          return Response.json({ status: "received", messageId: normalized.messageId });
        } catch (err: any) {
          return Response.json({ error: err.message || "Invalid payload" }, { status: 400 });
        }
      }

      return Response.json({ error: "Not Found" }, { status: 404 });
    },
  });

  return {
    server,
    port: server.port,
    stop: () => server.stop(),
    adminAuth,
    adminMgmt,
  };
}

// Standalone execution
if (import.meta.main) {
  const app = createAppServer();
  console.log(`[Rezervasiyon Bot Server] Running on http://localhost:${app.port}`);

  const handleShutdown = () => {
    console.log("[Rezervasiyon Bot Server] Gracefully shutting down...");
    app.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}
