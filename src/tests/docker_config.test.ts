import { describe, it, expect, afterAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createAppServer } from "../index";

describe("MASTER-24 — آزمون‌های کانتینرسازی داکر، شبیه‌سازی محلی و سلامت سرویس", () => {
  const rootDir = join(__dirname, "../..");

  it("DOCKER-01: ساختار و الزامات امنیتی Dockerfile باید معتبر و بدون کاربر روت باشد", () => {
    const dockerfilePath = join(rootDir, "Dockerfile");
    expect(existsSync(dockerfilePath)).toBe(true);

    const content = readFileSync(dockerfilePath, "utf-8");
    // بررسی ایمیج پایه Bun
    expect(content).toContain("FROM oven/bun:1-alpine");
    // بررسی کاربر غیر روت
    expect(content).toContain("USER bun");
    // بررسی وجود پروب سلامت
    expect(content).toContain("HEALTHCHECK");
    expect(content).toContain("/healthz");
    // بررسی اکسپوز پورت
    expect(content).toContain("EXPOSE 3000");
    // بررسی عدم وجود مقادیر هاردکد شده رمز یا توکن
    expect(content.toLowerCase()).not.toContain("bot_token_secret");
    expect(content.toLowerCase()).not.toContain("password123");
  });

  it("DOCKER-02: فایل docker-compose.yml باید از شبکه ایزوله و پورت‌های متغیر استفاده کند", () => {
    const composePath = join(rootDir, "docker-compose.yml");
    expect(existsSync(composePath)).toBe(true);

    const content = readFileSync(composePath, "utf-8");
    // بررسی سرویس app
    expect(content).toContain("services:");
    expect(content).toContain("app:");
    // بررسی استفاده از پورت داینامیک/متغیر با پیش‌فرض ایمن
    expect(content).toContain("${PORT:-3000}");
    // بررسی شبکه ایزوله و ولوم داده
    expect(content).toContain("networks:");
    expect(content).toContain("rezervasiyon_network");
    expect(content).toContain("volumes:");
    expect(content).toContain("rezervasiyon_data");
    // بررسی healthcheck در compose
    expect(content).toContain("healthcheck:");
    expect(content).toContain("/healthz");
  });

  it("DOCKER-03: فایل .env.example باید استاندارد، کامل و فاقد اطلاعات محرمانه باشد", () => {
    const envExamplePath = join(rootDir, ".env.example");
    expect(existsSync(envExamplePath)).toBe(true);

    const content = readFileSync(envExamplePath, "utf-8");
    // متغیرهای الزامی باید تعریف شده باشند
    expect(content).toContain("PORT=3000");
    expect(content).toContain("NODE_ENV=production");
    expect(content).toContain("ADMIN_WEBVIEW_SECRET=");
    expect(content).toContain("TELEGRAM_BOT_TOKEN=");
    expect(content).toContain("BALE_BOT_TOKEN=");
    expect(content).toContain("STORAGE_PATH=");

    // نباید هیچ رمز یا توکن واقعی وجود داشته باشد
    expect(content).toContain("mock_telegram_bot_token");
    expect(content).toContain("mock_bale_bot_token");
  });

  it("DOCKER-04: اندپوینت سلامت /healthz باید وضعیت سرویس را با کد ۲۰۰ بازگرداند", async () => {
    const app = createAppServer({ port: 3847 });
    try {
      const res = await fetch("http://localhost:3847/healthz");
      expect(res.status).toBe(200);

      const data = await res.json() as any;
      expect(data.status).toBe("healthy");
      expect(data.service).toBe("rezervasiyon-bot");
      expect(typeof data.timestamp).toBe("string");
    } finally {
      app.stop();
    }
  });

  it("DOCKER-05: اندپوینت سلامت مدیریت /admin/health و مسیرهای نامعتبر", async () => {
    const app = createAppServer({ port: 3848 });
    try {
      // تست سلامت ادمین
      const resAdmin = await fetch("http://localhost:3848/admin/health");
      expect(resAdmin.status).toBe(200);
      const adminData = await resAdmin.json() as any;
      expect(adminData.adminService).toBe("ready");

      // تست روت نامعتبر ۴۰۴
      const res404 = await fetch("http://localhost:3848/non-existent");
      expect(res404.status).toBe(404);
    } finally {
      app.stop();
    }
  });

  it("DOCKER-06: وب‌هوک‌های تلگرام و بله پیام‌های شبیه‌سازی‌شده را به درستی نرمال‌سازی می‌کنند", async () => {
    const app = createAppServer({ port: 3849 });
    try {
      // وب‌هوک تلگرام
      const telegramPayload = {
        message: {
          message_id: 8812,
          from: { id: 7001, first_name: "Ali" },
          chat: { id: 7001 },
          text: "/start",
          date: 1730000000,
        },
      };
      const tgRes = await fetch("http://localhost:3849/webhook/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(telegramPayload),
      });
      expect(tgRes.status).toBe(200);
      const tgData = await tgRes.json() as any;
      expect(tgData.status).toBe("received");
      expect(tgData.messageId).toBe("8812");

      // وب‌هوک بله
      const balePayload = {
        message: {
          message_id: 9912,
          from: { id: 8001, first_name: "Hossein" },
          chat: { id: 8001 },
          text: "ثبت رزرو",
          date: 1730000000,
        },
      };
      const baleRes = await fetch("http://localhost:3849/webhook/bale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(balePayload),
      });
      expect(baleRes.status).toBe(200);
      const baleData = await baleRes.json() as any;
      expect(baleData.status).toBe("received");
      expect(baleData.messageId).toBe("9912");
    } finally {
      app.stop();
    }
  });
});
