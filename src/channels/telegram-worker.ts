import { TelegramAdapter } from "./channel-adapter";
import { IdentityService } from "../core/identity/identity-service";
import { InventoryService } from "../core/inventory/inventory-service";

export interface BotWorkerConfig {
  token: string;
  role: "TRAVELER" | "HOST";
  adapter?: TelegramAdapter;
  identityService?: IdentityService;
  inventoryService?: InventoryService;
}

export class TelegramBotWorker {
  readonly token: string;
  readonly role: "TRAVELER" | "HOST";
  private isRunning: boolean = false;
  private offset: number = 0;
  private adapter: TelegramAdapter;
  private identityService: IdentityService;
  private inventoryService: InventoryService;

  constructor(config: BotWorkerConfig) {
    this.token = config.token;
    this.role = config.role;
    this.adapter = config.adapter ?? new TelegramAdapter();
    this.identityService = config.identityService ?? new IdentityService();
    this.inventoryService = config.inventoryService ?? new InventoryService();
  }

  async start() {
    if (!this.token || this.token.includes("mock") || this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      // Clear any conflicting webhooks
      await fetch(`https://api.telegram.org/bot${this.token}/deleteWebhook`);
      console.log(`[TelegramWorker - ${this.role}] Webhook cleared. Polling started.`);
    } catch (e) {
      console.error(`[TelegramWorker - ${this.role}] Error clearing webhook:`, e);
    }

    this.pollLoop();
  }

  stop() {
    this.isRunning = false;
  }

  private async pollLoop() {
    while (this.isRunning) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=15`,
          { signal: AbortSignal.timeout(25000) }
        );
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        const data = (await res.json()) as any;
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.offset = update.update_id + 1;
            await this.handleUpdate(update);
          }
        }
      } catch (err: any) {
        if (err.name !== "TimeoutError") {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  }

  private async handleUpdate(update: any) {
    try {
      const inbound = this.adapter.normalizeInbound(update, this.role);
      const chatId = inbound.chatId;
      if (!chatId) return;

      const text = inbound.text?.trim() || "";
      const callback = inbound.callbackData;

      if (update.callback_query?.id) {
        fetch(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: update.callback_query.id }),
        }).catch(() => {});
      }

      if (this.role === "TRAVELER") {
        await this.handleTravelerMessage(chatId, text, callback, inbound.fromUserId);
      } else {
        await this.handleHostMessage(chatId, text, callback, inbound.fromUserId);
      }
    } catch (err) {
      console.error(`[TelegramWorker - ${this.role}] Error handling update:`, err);
    }
  }

  private async handleTravelerMessage(chatId: string, text: string, callback?: string, fromUserId?: string) {
    if (text === "/start" || callback === "MENU") {
      if (fromUserId) {
        this.identityService.getOrCreateAccount("TELEGRAM", fromUserId);
      }
      const message = {
        chatId,
        text: `سلام و عرض ادب خدمت زائر گرامی 🌸\nبه <b>سامانه رزرواسیون اسکان موکب‌ها</b> خوش آمدید.\n\nلطفاً یکی از گزینه‌های زیر را انتخاب نمایید:`,
        inlineKeyboard: [
          [{ text: "🔍 جست‌وجوی موکب و اقامتگاه", callbackData: "SEARCH_SPACES" }],
          [{ text: "📋 پیگیری رزروهای من", callbackData: "MY_RESERVATIONS" }],
          [{ text: "🔗 اتصال به حساب بله (کد ۲۴ ساعته)", callbackData: "LINK_ACCOUNT" }],
          [{ text: "ℹ️ راهنما و قوانین اسکان", callbackData: "RULES_INFO" }],
        ],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "SEARCH_SPACES") {
      const message = {
        chatId,
        text: `<b>🔍 جست‌وجوی اقامتگاه‌های فعال:</b>\n\nشهرهای زیارتی تحت پوشش:\n• کربلای معلی 🇮🇶\n• نجف اشرف 🇮🇶\n• مشهد مقدس 🇮🇷\n• قم مقدسه 🇮🇷\n\nجهت ثبت درخواست، ظرفیت‌های خالی در روزهای آینده فعال خواهند شد.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "MY_RESERVATIONS") {
      const message = {
        chatId,
        text: `<b>📋 پیگیری رزروها:</b>\n\nتاکنون رزرو قطعی برای حساب کاربری شما ثبت نشده است.\nجهت ثبت رزرو از بخش «جست‌وجوی موکب و اقامتگاه» اقدام فرمایید.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "LINK_ACCOUNT") {
      let codeText = "خطا در صدور کد";
      if (fromUserId) {
        const account = this.identityService.getOrCreateAccount("TELEGRAM", fromUserId);
        const code = this.identityService.generateLinkingCode(account.id);
        codeText = `کد پیوند اختصاصی شما: <code>${code.code}</code>\n\n⏳ اعتبار: ۲۴ ساعت (یک‌بارمصرف)\nاین کد را در بازوی بله ارسال کنید تا حساب‌های شما متصل شوند.`;
      }
      const message = {
        chatId,
        text: `<b>🔗 اتصال یکپارچه حساب تلگرام و بله:</b>\n\n${codeText}`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "RULES_INFO") {
      const message = {
        chatId,
        text: `<b>ℹ️ قوانین و ضوابط رزرواسیون:</b>\n\n۱. رزرو حداکثر تا ۷ روز پیش از ورود به وقت شهر مقصد امکان‌پذیر است.\n۲. لغو رایگان تا ۲۴ ساعت پیش از ساعت ورود امکان‌پذیر است.\n۳. کودکان در ظرفیت اسمی اتاق‌ها شمرده می‌شوند.\n۴. در مسیرهای پولی، پرداخت از طریق کارت‌به‌کارت و بررسی توسط موکب‌دار انجام می‌شود.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    await this.sendMessage({
      chatId,
      text: `پیام شما دریافت شد. لطفاً از دکمه‌های زیر استفاده فرمایید:`,
      inlineKeyboard: [[{ text: "🔙 منوی اصلی", callbackData: "MENU" }]],
    });
  }

  private async handleHostMessage(chatId: string, text: string, callback?: string, fromUserId?: string) {
    if (text === "/start" || callback === "HOST_MENU") {
      const message = {
        chatId,
        text: `سلام و احترام خدمت خادم و موکب‌دار گرامی 🏴\nبه <b>سامانه مدیریت و کارتابل موکب‌داران</b> خوش آمدید.\n\nلطفاً یکی از بخش‌های زیر را انتخاب نمایید:`,
        inlineKeyboard: [
          [{ text: "➕ ثبت موکب و ظرفیت جدید", callbackData: "REGISTER_HOST" }],
          [{ text: "📋 کارتابل درخواست‌های رزرو مسافران", callbackData: "PENDING_REQUESTS" }],
          [{ text: "📊 وضعیت سالن‌ها و اتاق‌ها", callbackData: "ROOMS_STATUS" }],
          [{ text: "💳 فیش‌های واریزی در انتظار تأیید", callbackData: "RECEIPTS_INBOX" }],
        ],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "REGISTER_HOST") {
      const message = {
        chatId,
        text: `<b>➕ ثبت موکب و فضاهای اسکان:</b>\n\nمدارک لازم جهت تأیید:\n۱. نام و مشخصات مسئول موکب\n۲. شماره تماس معتبر\n۳. نشانی دقیق و موقعیت جغرافیایی\n۴. تصویر محل اسکان و مدرک مسئولیت موکب\n\nپس از ارسال مشخصات، کارشناس سامانه اطلاعات را بررسی و تأیید خواهد کرد.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "PENDING_REQUESTS") {
      const message = {
        chatId,
        text: `<b>📋 کارتابل درخواست‌های رزرو:</b>\n\nدر حال حاضر درخواست جدیدی در انتظار تأیید شما نیست.\nبه محض ثبت درخواست جدید توسط زائران، اعلان آن برای شما ارسال خواهد شد.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "ROOMS_STATUS") {
      const message = {
        chatId,
        text: `<b>📊 وضعیت ظرفیت موکب:</b>\n\nانواع اقامتگاه‌ها:\n• سالن‌های عمومی (تفکیک آقایان و بانوان)\n• اتاق‌های مستقل خانوادگی (دربست)\n\nتمامی تقویم‌ها به صورت لحظه‌ای با سامانه مرکزی همگام هستند.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    if (callback === "RECEIPTS_INBOX") {
      const message = {
        chatId,
        text: `<b>💳 کارتابل بررسی فیش‌های واریزی:</b>\n\nهیچ فیش جدیدی در صف بررسی وجود ندارد.\n(طبق قوانین، بررسی فیش‌ها منحصراً توسط شخص موکب‌دار انجام می‌شود).`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.sendMessage(message);
      return;
    }

    await this.sendMessage({
      chatId,
      text: `دستور نامشخص است. لطفاً از منوی زیر استفاده کنید:`,
      inlineKeyboard: [[{ text: "🔙 منوی موکب‌دار", callbackData: "HOST_MENU" }]],
    });
  }

  private async sendMessage(msg: { chatId: string; text: string; inlineKeyboard?: any[][] }) {
    try {
      const payload = this.adapter.formatOutbound({
        chatId: msg.chatId,
        text: msg.text,
        inlineKeyboard: msg.inlineKeyboard,
      });

      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error(`[TelegramWorker - ${this.role}] Send error:`, err);
    }
  }
}
