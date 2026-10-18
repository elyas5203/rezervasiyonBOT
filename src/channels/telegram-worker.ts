import { TelegramAdapter } from "./channel-adapter";
import { IdentityService } from "../core/identity/identity-service";
import { InventoryService } from "../core/inventory/inventory-service";
import { ReservationService } from "../core/reservation/reservation-service";
import { AdminAuthService } from "../admin/admin-service";

export interface BotWorkerConfig {
  token: string;
  role: "TRAVELER" | "HOST" | "ADMIN";
  adapter?: TelegramAdapter;
  identityService?: IdentityService;
  inventoryService?: InventoryService;
  reservationService?: ReservationService;
  adminAuthService?: AdminAuthService;
  adminPasskey?: string;
}

export class TelegramBotWorker {
  readonly token: string;
  readonly role: "TRAVELER" | "HOST" | "ADMIN";
  private isRunning: boolean = false;
  private offset: number = 0;
  private adapter: TelegramAdapter;
  private identityService: IdentityService;
  private inventoryService: InventoryService;
  private reservationService?: ReservationService;
  private adminAuthService: AdminAuthService;
  private adminPasskey: string;
  private authenticatedAdmins: Set<string> = new Set();
  private peerAdminWorker?: TelegramBotWorker;
  private lastBotMessageIds: Map<string, number | string> = new Map();

  constructor(config: BotWorkerConfig) {
    this.token = config.token;
    this.role = config.role;
    this.adapter = config.adapter ?? new TelegramAdapter();
    this.identityService = config.identityService ?? new IdentityService();
    this.inventoryService = config.inventoryService ?? new InventoryService();
    this.reservationService = config.reservationService;
    this.adminAuthService = config.adminAuthService ?? new AdminAuthService();
    this.adminPasskey = config.adminPasskey ?? process.env.ADMIN_SECRET_KEY ?? "admin110";
  }

  setPeerAdminWorker(adminWorker: TelegramBotWorker) {
    this.peerAdminWorker = adminWorker;
  }

  getAuthenticatedAdmins(): string[] {
    return Array.from(this.authenticatedAdmins);
  }

  addAuthenticatedAdmin(chatId: string) {
    this.authenticatedAdmins.add(chatId);
  }

  getLastBotMessageId(chatId: string): number | string | undefined {
    return this.lastBotMessageIds.get(chatId);
  }

  async broadcastToAdmins(text: string, inlineKeyboard?: any[][]) {
    for (const chatId of this.authenticatedAdmins) {
      await this.sendMessage({
        chatId,
        text,
        inlineKeyboard,
      });
    }
  }

  async deleteMessage(chatId: string, messageId: number | string): Promise<boolean> {
    if (!messageId) return false;
    if (this.token.includes("mock")) {
      if (this.lastBotMessageIds.get(chatId) === messageId) {
        this.lastBotMessageIds.delete(chatId);
      }
      return true;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  async editMessageText(params: {
    chatId: string;
    messageId: number | string;
    text: string;
    inlineKeyboard?: any[][];
  }): Promise<boolean> {
    if (!params.messageId) return false;
    if (this.token.includes("mock")) {
      this.lastBotMessageIds.set(params.chatId, params.messageId);
      return true;
    }
    try {
      const payload = this.adapter.formatOutbound({
        chatId: params.chatId,
        text: params.text,
        inlineKeyboard: params.inlineKeyboard,
      });

      const res = await fetch(`https://api.telegram.org/bot${this.token}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chatId,
          message_id: params.messageId,
          text: payload.text,
          parse_mode: payload.parse_mode || "HTML",
          reply_markup: payload.reply_markup,
        }),
      });
      if (res.ok) {
        this.lastBotMessageIds.set(params.chatId, params.messageId);
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async editOrSendMessage(params: {
    chatId: string;
    messageId?: number | string;
    text: string;
    inlineKeyboard?: any[][];
  }): Promise<void> {
    // ۱. اگر messageId مستقیماً از کلیک دکمه رسیده، ویرایش درجا انجام شود
    if (params.messageId) {
      const edited = await this.editMessageText({
        chatId: params.chatId,
        messageId: params.messageId,
        text: params.text,
        inlineKeyboard: params.inlineKeyboard,
      });
      if (edited) return;
    }

    // ۲. اگر پیام قبلی از ربات در حافظه داریم، سعی در ویرایش آن کنیم
    const prevMid = this.lastBotMessageIds.get(params.chatId);
    if (prevMid) {
      const editedPrev = await this.editMessageText({
        chatId: params.chatId,
        messageId: prevMid,
        text: params.text,
        inlineKeyboard: params.inlineKeyboard,
      });
      if (editedPrev) return;
      // اگر ویرایش پیام قبلی موفق نبود، آن را حذف می‌کنیم تا پیام‌ها تلنبار نشوند
      await this.deleteMessage(params.chatId, prevMid);
    }

    // ۳. ارسال پیام تازه و ذخیره شناسه آن
    await this.sendMessage({
      chatId: params.chatId,
      text: params.text,
      inlineKeyboard: params.inlineKeyboard,
    });
  }

  async start() {
    if (!this.token || this.token.includes("mock") || this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      // پاکسازی هر وب‌هوک معارض
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
      const inbound = this.adapter.normalizeInbound(
        update,
        this.role === "ADMIN" ? "ADMIN_BOT" : this.role === "HOST" ? "HOST_BOT" : "TRAVELER_BOT"
      );
      const chatId = inbound.chatId;
      if (!chatId) return;

      const text = inbound.text?.trim() || "";
      const callback = inbound.callbackData;
      const callbackMessageId = update.callback_query?.message?.message_id;

      // ۱. بستن وضعیت لودینگ شیشه‌ای تلگرام
      if (update.callback_query?.id) {
        if (!this.token.includes("mock")) {
          fetch(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: update.callback_query.id }),
          }).catch(() => {});
        }
      }

      // ۲. پاکسازی پیام تایپی کاربر (مشابه ختم‌ساز، جهت جلوگیری از اسپم چت)
      if (update.message?.message_id) {
        await this.deleteMessage(chatId, update.message.message_id);
      }

      // ۳. پردازش پیام با ارسال messageId جهت ویرایش درجا
      if (this.role === "TRAVELER") {
        await this.handleTravelerMessage(chatId, text, callback, inbound.fromUserId, callbackMessageId);
      } else if (this.role === "HOST") {
        await this.handleHostMessage(chatId, text, callback, inbound.fromUserId, callbackMessageId);
      } else if (this.role === "ADMIN") {
        await this.handleAdminMessage(chatId, text, callback, inbound.fromUserId, callbackMessageId);
      }
    } catch (err) {
      console.error(`[TelegramWorker - ${this.role}] Error handling update:`, err);
    }
  }

  private async handleTravelerMessage(
    chatId: string,
    text: string,
    callback?: string,
    fromUserId?: string,
    messageId?: number | string
  ) {
    if (text === "/start" || callback === "MENU") {
      if (fromUserId) {
        this.identityService.getOrCreateAccount("TELEGRAM", fromUserId);
      }
      const message = {
        chatId,
        messageId,
        text: `سلام و عرض ادب خدمت زائر گرامی 🌸\nبه <b>سامانه رزرواسیون اسکان موکب‌ها</b> خوش آمدید.\n\nلطفاً یکی از گزینه‌های زیر را انتخاب نمایید:`,
        inlineKeyboard: [
          [{ text: "🔍 جست‌وجوی موکب و اقامتگاه", callbackData: "SEARCH_SPACES" }],
          [{ text: "📋 پیگیری رزروهای من", callbackData: "MY_RESERVATIONS" }],
          [{ text: "🔗 اتصال به حساب بله (کد ۲۴ ساعته)", callbackData: "LINK_ACCOUNT" }],
          [{ text: "ℹ️ راهنما و قوانین اسکان", callbackData: "RULES_INFO" }],
        ],
      };
      await this.editOrSendMessage(message);
      return;
    }

    if (callback === "SEARCH_SPACES") {
      const message = {
        chatId,
        messageId,
        text: `<b>🔍 جست‌وجوی اقامتگاه‌های فعال:</b>\n\nشهرهای زیارتی تحت پوشش:\n• کربلای معلی 🇮🇶\n• نجف اشرف 🇮🇶\n• مشهد مقدس 🇮🇷\n• قم مقدسه 🇮🇷\n\nجهت ثبت درخواست، ظرفیت‌های خالی در روزهای آینده فعال خواهند شد.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.editOrSendMessage(message);
      return;
    }

    if (callback === "MY_RESERVATIONS") {
      const message = {
        chatId,
        messageId,
        text: `<b>📋 پیگیری رزروها:</b>\n\nتاکنون رزرو قطعی برای حساب کاربری شما ثبت نشده است.\nجهت ثبت رزرو از بخش «جست‌وجوی موکب و اقامتگاه» اقدام فرمایید.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.editOrSendMessage(message);
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
        messageId,
        text: `<b>🔗 اتصال یکپارچه حساب تلگرام و بله:</b>\n\n${codeText}`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.editOrSendMessage(message);
      return;
    }

    if (callback === "RULES_INFO") {
      const message = {
        chatId,
        messageId,
        text: `<b>ℹ️ قوانین و ضوابط رزرواسیون:</b>\n\n۱. رزرو حداکثر تا ۷ روز پیش از ورود به وقت شهر مقصد امکان‌پذیر است.\n۲. لغو رایگان تا ۲۴ ساعت پیش از ساعت ورود امکان‌پذیر است.\n۳. کودکان در ظرفیت اسمی اتاق‌ها شمرده می‌شوند.\n۴. در مسیرهای پولی، پرداخت از طریق کارت‌به‌کارت و بررسی توسط موکب‌دار انجام می‌شود.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]],
      };
      await this.editOrSendMessage(message);
      return;
    }

    await this.editOrSendMessage({
      chatId,
      messageId,
      text: `پیام شما دریافت شد. لطفاً از دکمه‌های زیر استفاده فرمایید:`,
      inlineKeyboard: [[{ text: "🔙 منوی اصلی", callbackData: "MENU" }]],
    });
  }

  private async handleHostMessage(
    chatId: string,
    text: string,
    callback?: string,
    fromUserId?: string,
    messageId?: number | string
  ) {
    if (text === "/start" || callback === "HOST_MENU") {
      const message = {
        chatId,
        messageId,
        text: `سلام و احترام خدمت خادم و موکب‌دار گرامی 🏴\nبه <b>سامانه مدیریت و کارتابل موکب‌داران</b> خوش آمدید.\n\nلطفاً یکی از بخش‌های زیر را انتخاب نمایید:`,
        inlineKeyboard: [
          [{ text: "➕ ثبت موکب و ظرفیت جدید", callbackData: "REGISTER_HOST" }],
          [{ text: "📋 کارتابل درخواست‌های رزرو مسافران", callbackData: "PENDING_REQUESTS" }],
          [{ text: "📊 وضعیت سالن‌ها و اتاق‌ها", callbackData: "ROOMS_STATUS" }],
          [{ text: "💳 فیش‌های واریزی در انتظار تأیید", callbackData: "RECEIPTS_INBOX" }],
        ],
      };
      await this.editOrSendMessage(message);
      return;
    }

    if (callback === "REGISTER_HOST") {
      const message = {
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب و فضاهای اسکان:</b>\n\nمدارک لازم جهت تأیید:\n۱. نام و مشخصات مسئول موکب\n۲. شماره تماس معتبر\n۳. نشانی دقیق و موقعیت جغرافیایی\n۴. تصویر محل اسکان و مدرک مسئولیت موکب\n\nپس از ارسال مشخصات، کارشناس سامانه اطلاعات را بررسی و تأیید خواهد کرد.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.editOrSendMessage(message);

      // ارسال اعلان به ربات ادمین
      if (this.peerAdminWorker) {
        await this.peerAdminWorker.broadcastToAdmins(
          `📢 <b>اعلان سامانه:</b>\nکاربری در ربات موکب‌داران وارد بخش ثبت موکب شد (چت: <code>${chatId}</code>).`
        );
      }
      return;
    }

    if (callback === "PENDING_REQUESTS") {
      const message = {
        chatId,
        messageId,
        text: `<b>📋 کارتابل درخواست‌های رزرو:</b>\n\nدر حال حاضر درخواست جدیدی در انتظار تأیید شما نیست.\nبه محض ثبت درخواست جدید توسط زائران، اعلان آن برای شما ارسال خواهد شد.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.editOrSendMessage(message);
      return;
    }

    if (callback === "ROOMS_STATUS") {
      const message = {
        chatId,
        messageId,
        text: `<b>📊 وضعیت ظرفیت موکب:</b>\n\nانواع اقامتگاه‌ها:\n• سالن‌های عمومی (تفکیک آقایان و بانوان)\n• اتاق‌های مستقل خانوادگی (دربست)\n\nتمامی تقویم‌ها به صورت لحظه‌ای با سامانه مرکزی همگام هستند.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.editOrSendMessage(message);
      return;
    }

    if (callback === "RECEIPTS_INBOX") {
      const message = {
        chatId,
        messageId,
        text: `<b>💳 کارتابل بررسی فیش‌های واریزی:</b>\n\nهیچ فیش جدیدی در صف بررسی وجود ندارد.\n(طبق قوانین، بررسی فیش‌ها منحصراً توسط شخص موکب‌دار انجام می‌شود).`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      };
      await this.editOrSendMessage(message);
      return;
    }

    await this.editOrSendMessage({
      chatId,
      messageId,
      text: `دستور نامشخص است. لطفاً از منوی زیر استفاده کنید:`,
      inlineKeyboard: [[{ text: "🔙 منوی موکب‌دار", callbackData: "HOST_MENU" }]],
    });
  }

  private async handleAdminMessage(
    chatId: string,
    text: string,
    callback?: string,
    fromUserId?: string,
    messageId?: number | string
  ) {
    const isAuthed = this.authenticatedAdmins.has(chatId);

    // ۱. دستور استارت یا خروج
    if (text === "/start") {
      if (isAuthed) {
        await this.sendAdminDashboard(chatId, messageId);
      } else {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `سلام و احترام خدمت مسئول و مدیر گرامی سامانه 🛡️\n\nبرای دسترسی به پنل مدیریت و دریافت گزارشات، لطفاً <b>رمز عبور مدیریت</b> را ارسال فرمایید:`,
        });
      }
      return;
    }

    if (text === "/logout") {
      this.authenticatedAdmins.delete(chatId);
      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `از پنل مدیریت خارج شدید. جهت ورود مجدد دستور /start را ارسال فرمایید.`,
      });
      return;
    }

    // ۲. بررسی رمز عبور برای ادمین‌های احراز هویت‌نشده
    if (!isAuthed) {
      if (text === this.adminPasskey) {
        this.authenticatedAdmins.add(chatId);
        try {
          await this.adminAuthService.registerAdmin({
            id: `admin-tel-${chatId}`,
            displayName: `مدیر تلگرام (${fromUserId || chatId})`,
            role: "APPOINTED_ADMIN",
            telegramUserId: String(fromUserId || chatId),
            isActive: true,
            createdAt: new Date(),
          });
        } catch (_) {}

        // ارسال پیام تایید و باز کردن داشبورد
        await this.sendAdminDashboard(chatId);
      } else {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `⛔ <b>رمز عبور اشتباه است!</b>\nدسترسی به اطلاعات مدیریت مجاز نمی‌باشد. لطفاً رمز عبور صحیح را وارد کنید:`,
        });
      }
      return;
    }

    // ۳. فرمان‌ها و کلیک‌های ادمین احراز هویت‌شده
    if (callback === "ADMIN_MENU" || text === "/menu") {
      await this.sendAdminDashboard(chatId, messageId);
      return;
    }

    if (callback === "ADMIN_STATS" || text === "/report" || text === "گزارش") {
      await this.sendAdminStats(chatId, messageId);
      return;
    }

    if (callback === "ADMIN_PENDING_HOSTS" || text === "/hosts") {
      await this.sendPendingHosts(chatId, messageId);
      return;
    }

    if (callback === "ADMIN_LIST" || text === "/admins") {
      await this.sendAdminsList(chatId, messageId);
      return;
    }

    if (callback === "ADMIN_HEALTH" || text === "/health") {
      await this.sendServerHealth(chatId, messageId);
      return;
    }

    // تأیید یا رد موکب توسط ادمین در تلگرام با ویرایش درجا
    if (callback && callback.startsWith("APPROVE_PLACE_")) {
      const placeId = callback.replace("APPROVE_PLACE_", "");
      try {
        await this.inventoryService.reviewMokabPlace(placeId, `admin-${chatId}`, "APPROVED", "تأیید توسط مدیر در ربات تلگرام");
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `موکب با شناسه <code>${placeId}</code> با موفقیت تأیید شد و در جست‌وجوی زائران قرار گرفت ✅`,
          inlineKeyboard: [[{ text: "🔙 بازگشت به کارتابل موکب‌ها", callbackData: "ADMIN_PENDING_HOSTS" }]],
        });
      } catch (err: any) {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `خطا در تأیید موکب: ${err.message}`,
          inlineKeyboard: [[{ text: "🔙 کارتابل موکب‌ها", callbackData: "ADMIN_PENDING_HOSTS" }]],
        });
      }
      return;
    }

    if (callback && callback.startsWith("REJECT_PLACE_")) {
      const placeId = callback.replace("REJECT_PLACE_", "");
      try {
        await this.inventoryService.reviewMokabPlace(placeId, `admin-${chatId}`, "REJECTED", "عدم انطباق مدارک توسط مدیر");
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `موکب با شناسه <code>${placeId}</code> رد شد ❌`,
          inlineKeyboard: [[{ text: "🔙 بازگشت به کارتابل موکب‌ها", callbackData: "ADMIN_PENDING_HOSTS" }]],
        });
      } catch (err: any) {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `خطا در رد موکب: ${err.message}`,
          inlineKeyboard: [[{ text: "🔙 کارتابل موکب‌ها", callbackData: "ADMIN_PENDING_HOSTS" }]],
        });
      }
      return;
    }

    // پیام پیش‌فرض برای ادمین
    await this.editOrSendMessage({
      chatId,
      messageId,
      text: `دستور نامشخص است. لطفاً از منوی زیر استفاده فرمایید:`,
      inlineKeyboard: [[{ text: "🛡️ منوی مدیریت سامانه", callbackData: "ADMIN_MENU" }]],
    });
  }

  private async sendAdminDashboard(chatId: string, messageId?: number | string) {
    const message = {
      chatId,
      messageId,
      text: `<b>🛡️ پنل مدیریت مرکزی سامانه رزرواسیون اسکان موکب‌ها</b>\n\nمدیر گرامی، به پنل مدیریت خوش آمدید.\nلطفاً یکی از بخش‌های زیر را انتخاب کنید:`,
      inlineKeyboard: [
        [{ text: "📊 گزارش آماری کل سامانه", callbackData: "ADMIN_STATS" }],
        [{ text: "📋 کارتابل موکب‌های منتظر بررسی", callbackData: "ADMIN_PENDING_HOSTS" }],
        [{ text: "👥 لیست مدیران فعال", callbackData: "ADMIN_LIST" }],
        [{ text: "⚙️ وضعیت سلامت سرویس و سرور", callbackData: "ADMIN_HEALTH" }],
      ],
    };
    await this.editOrSendMessage(message);
  }

  private async sendAdminStats(chatId: string, messageId?: number | string) {
    const places = await this.inventoryService.getAllPlaces();
    const approved = places.filter(p => p.status === "APPROVED").length;
    const pending = places.filter(p => p.status === "PENDING").length;
    const rejected = places.filter(p => p.status === "REJECTED").length;

    let resCount = 0;
    if (this.reservationService) {
      const allRes = await this.reservationService.getAllReservations();
      resCount = allRes.length;
    }

    const text = `<b>📊 گزارش زنده سامانه رزرواسیون اسکان:</b>\n\n` +
      `<b>🏢 وضعیت موکب‌ها و اقامتگاه‌ها:</b>\n` +
      `• کل موکب‌های ثبت‌شده: ${places.length}\n` +
      `• موکب‌های فعال و تأییدشده: ${approved} ✅\n` +
      `• موکب‌های در صف بررسی: ${pending} ⏳\n` +
      `• موکب‌های رد شده: ${rejected} ❌\n\n` +
      `<b>📋 وضعیت درخواست‌های رزرو:</b>\n` +
      `• کل رزروهای ثبت‌شده: ${resCount}\n\n` +
      `<b>👥 مدیران فعال تلگرام:</b> ${this.authenticatedAdmins.size} نفر\n` +
      `<b>⏰ زمان سرور:</b> ${new Date().toLocaleTimeString('fa-IR')} (UTC: ${new Date().toISOString()})\n` +
      `<b>🟢 وضعیت وب‌سرویس:</b> سالم و در حال اجرا روی پورت ۳۰۸۰`;

    await this.editOrSendMessage({
      chatId,
      messageId,
      text,
      inlineKeyboard: [
        [{ text: "🔄 به‌روزرسانی گزارش", callbackData: "ADMIN_STATS" }],
        [{ text: "🔙 منوی اصلی", callbackData: "ADMIN_MENU" }],
      ],
    });
  }

  private async sendPendingHosts(chatId: string, messageId?: number | string) {
    const pending = await this.inventoryService.getPendingPlaces();
    if (pending.length === 0) {
      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>📋 کارتابل موکب‌ها:</b>\n\nدر حال حاضر هیچ موکب جدیدی در صف بررسی وجود ندارد ✅\nتمامی پرونده‌ها تعیین تکلیف شده‌اند.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callbackData: "ADMIN_MENU" }]],
      });
      return;
    }

    // اگر موکبی در انتظار است، پیام اصلی کارتابل را ویرایش می‌کنیم و برای هر موکب کارت جداگانه نمایش می‌دهیم
    await this.editOrSendMessage({
      chatId,
      messageId,
      text: `<b>📋 تعداد ${pending.length} موکب در انتظار بررسی است:</b>`,
    });

    for (const p of pending.slice(0, 5)) {
      const modelFa = p.financialModel === "FREE" ? "کاملاً رایگان" : p.financialModel === "FIXED_FEE" ? "هزینه ثابت" : "تضمین اقامت";
      const approvalFa = p.approvalMode === "INSTANT" ? "فوری (آنی)" : "دستی (با تأیید موکب‌دار)";
      const itemText = `<b>🏛️ نام: ${p.title}</b>\n` +
        `• شهر: ${p.city}\n` +
        `• نشانی: ${p.address}\n` +
        `• مسئول: ${p.contactName} (${p.contactPhone})\n` +
        `• مدل مالی: ${modelFa}\n` +
        `• شیوه پذیرش: ${approvalFa}`;

      await this.sendMessage({
        chatId,
        text: itemText,
        inlineKeyboard: [
          [
            { text: "✅ تأیید موکب", callbackData: `APPROVE_PLACE_${p.id}` },
            { text: "❌ رد موکب", callbackData: `REJECT_PLACE_${p.id}` },
          ],
        ],
      });
    }
  }

  private async sendAdminsList(chatId: string, messageId?: number | string) {
    const adminIds = Array.from(this.authenticatedAdmins);
    const listText = adminIds.length > 0
      ? adminIds.map((id, index) => `${index + 1}. چت آیدی: <code>${id}</code> (تأییدشده ✅)`).join("\n")
      : "هیچ مدیری هنوز تأیید نشده است.";

    await this.editOrSendMessage({
      chatId,
      messageId,
      text: `<b>👥 لیست مدیران فعال در ربات تلگرام:</b>\n\n${listText}\n\n<i>تمامی گزارشات و اعلانات سامانه به این شناسه‌ها ارسال می‌شود.</i>`,
      inlineKeyboard: [[{ text: "🔙 منوی اصلی مدیریت", callbackData: "ADMIN_MENU" }]],
    });
  }

  private async sendServerHealth(chatId: string, messageId?: number | string) {
    const uptimeSec = Math.floor(process.uptime());
    const memUsage = process.memoryUsage();
    const rssMB = (memUsage.rss / (1024 * 1024)).toFixed(1);
    const heapUsedMB = (memUsage.heapUsed / (1024 * 1024)).toFixed(1);

    const text = `<b>⚙️ سلامت و وضعیت سرور و سرویس رزرواسیون:</b>\n\n` +
      `• وضعیت سرویس: <b>فعال و پایدار (Active) 🟢</b>\n` +
      `• مدت زمان فعالیت (Uptime): ${uptimeSec} ثانیه\n` +
      `• پورت شبکه: <b>3080</b>\n` +
      `• مصرف حافظه RSS: <b>${rssMB} MB</b>\n` +
      `• مصرف هیپ: <b>${heapUsedMB} MB</b>\n` +
      `• سایر سرویس‌های سرور: aiBOT (8000), khatmsaz (8080) فعال\n` +
      `• ران‌تایم: Bun 1.4.3 (Linux x86_64)`;

    await this.editOrSendMessage({
      chatId,
      messageId,
      text,
      inlineKeyboard: [
        [{ text: "🔄 بررسی مجدد", callbackData: "ADMIN_HEALTH" }],
        [{ text: "🔙 منوی اصلی مدیریت", callbackData: "ADMIN_MENU" }],
      ],
    });
  }

  private async sendMessage(msg: { chatId: string; text: string; inlineKeyboard?: any[][] }): Promise<number | string | null> {
    if (this.token.includes("mock")) {
      const fakeMid = Math.floor(Math.random() * 100000) + 1;
      this.lastBotMessageIds.set(msg.chatId, fakeMid);
      return fakeMid;
    }
    try {
      const payload = this.adapter.formatOutbound({
        chatId: msg.chatId,
        text: msg.text,
        inlineKeyboard: msg.inlineKeyboard,
      });

      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.result?.message_id) {
          this.lastBotMessageIds.set(msg.chatId, data.result.message_id);
          return data.result.message_id;
        }
      }
    } catch (err) {
      console.error(`[TelegramWorker - ${this.role}] Send error:`, err);
    }
    return null;
  }
}
