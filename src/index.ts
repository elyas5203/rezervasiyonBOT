import { TelegramAdapter, BaleAdapter, MessageDeduplicator } from "./channels/channel-adapter";
import { TelegramBotWorker } from "./channels/telegram-worker";
import { AdminAuthService, AdminManagementService } from "./admin/admin-service";
import { IdentityService } from "./core/identity/identity-service";
import { InventoryService } from "./core/inventory/inventory-service";
import { ReservationService } from "./core/reservation/reservation-service";
import { CapacityService } from "./core/capacity/capacity-service";

export interface AppServerConfig {
  port?: number;
  adminSecret?: string;
  travelerBotToken?: string;
  hostBotToken?: string;
  adminBotToken?: string;
  adminPasskey?: string;
  autoStartWorkers?: boolean;
}

export function createAppServer(config: AppServerConfig = {}) {
  const port = config.port ?? Number(process.env.PORT || 3000);
  const deduplicator = new MessageDeduplicator();
  const telegramAdapter = new TelegramAdapter(deduplicator);
  const baleAdapter = new BaleAdapter(deduplicator);
  const adminAuth = new AdminAuthService(config.adminSecret ?? process.env.ADMIN_WEBVIEW_SECRET ?? "default_dev_secret");
  const identityService = new IdentityService();
  const inventoryService = new InventoryService();
  const capacityService = new CapacityService();
  const reservationService = new ReservationService(capacityService);
  const adminMgmt = new AdminManagementService(adminAuth, inventoryService, reservationService);

  const travelerToken = config.travelerBotToken ?? process.env.TELEGRAM_TRAVELER_BOT_TOKEN;
  const hostToken = config.hostBotToken ?? process.env.TELEGRAM_HOST_BOT_TOKEN;
  const adminToken = config.adminBotToken ?? process.env.TELEGRAM_ADMIN_BOT_TOKEN;
  const adminPasskey = config.adminPasskey ?? process.env.ADMIN_SECRET_KEY ?? "admin110";

  let travelerWorker: TelegramBotWorker | null = null;
  let hostWorker: TelegramBotWorker | null = null;
  let adminWorker: TelegramBotWorker | null = null;

  if (adminToken && !adminToken.includes("mock")) {
    adminWorker = new TelegramBotWorker({
      token: adminToken,
      role: "ADMIN",
      adapter: telegramAdapter,
      identityService,
      inventoryService,
      reservationService,
      adminAuthService: adminAuth,
      adminPasskey,
    });
  }

  if (travelerToken && !travelerToken.includes("mock")) {
    travelerWorker = new TelegramBotWorker({
      token: travelerToken,
      role: "TRAVELER",
      adapter: telegramAdapter,
      identityService,
      inventoryService,
      reservationService,
    });
  }

  if (hostToken && !hostToken.includes("mock")) {
    hostWorker = new TelegramBotWorker({
      token: hostToken,
      role: "HOST",
      adapter: telegramAdapter,
      identityService,
      inventoryService,
      reservationService,
    });
  }

  if (hostWorker && adminWorker) {
    hostWorker.setPeerAdminWorker(adminWorker);
  }

  const startWorkers = async () => {
    if (travelerWorker) {
      await travelerWorker.start();
    }
    if (hostWorker) {
      await hostWorker.start();
    }
    if (adminWorker) {
      await adminWorker.start();
    }
  };

  const stopWorkers = () => {
    if (travelerWorker) travelerWorker.stop();
    if (hostWorker) hostWorker.stop();
    if (adminWorker) adminWorker.stop();
  };

  if (config.autoStartWorkers) {
    startWorkers().catch((err) => {
      console.error("[Rezervasiyon Bot Server] Failed to auto-start bot workers:", err);
    });
  }

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
    stop: () => {
      stopWorkers();
      server.stop();
    },
    startWorkers,
    stopWorkers,
    adminAuth,
    adminMgmt,
    travelerWorker,
    hostWorker,
    adminWorker,
  };
}

// Standalone execution
if (import.meta.main) {
  const app = createAppServer();
  console.log(`[Rezervasiyon Bot Server] Running on http://localhost:${app.port}`);

  app.startWorkers().catch((err) => {
    console.error("[Rezervasiyon Bot Server] Error starting bot workers:", err);
  });

  const handleShutdown = () => {
    console.log("[Rezervasiyon Bot Server] Gracefully shutting down...");
    app.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}
