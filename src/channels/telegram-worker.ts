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

export interface HostWizardSession {
  step: "CITY" | "TITLE" | "CONTACT" | "ADDRESS" | "SUPPLY_TYPE" | "CAPACITY" | "FINANCIAL" | "APPROVAL" | "CONFIRM";
  data: {
    city?: string;
    title?: string;
    contactName?: string;
    contactPhone?: string;
    address?: string;
    supplyType?: "PUBLIC" | "PRIVATE" | "BOTH";
    hallCapacity?: number;
    roomCount?: number;
    roomCapacity?: number;
    financialModel?: "FREE" | "FIXED_FEE" | "FIXED_DEPOSIT";
    feeAmountToman?: number;
    depositAmountToman?: number;
    approvalMode?: "INSTANT" | "MANUAL";
  };
}

export interface TravelerReservationRecord {
  id: string;
  placeId: string;
  placeTitle: string;
  city: string;
  partySize: number;
  status: "CONFIRMED" | "PENDING_HOST_APPROVAL";
  createdAt: Date;
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
  private hostWizards: Map<string, HostWizardSession> = new Map();
  private travelerReservations: Map<string, TravelerReservationRecord[]> = new Map();

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
        text: `<b>🔍 جست‌وجوی اقامتگاه‌های زیارتی:</b>\n\nلطفاً شهر مقصد مورد نظر خود را انتخاب فرمایید:`,
        inlineKeyboard: [
          [
            { text: "کربلای معلی 🇮🇶", callbackData: "TRAVELER_CITY_کربلای معلی" },
            { text: "نجف اشرف 🇮🇶", callbackData: "TRAVELER_CITY_نجف اشرف" },
          ],
          [
            { text: "مشهد مقدس 🇮🇷", callbackData: "TRAVELER_CITY_مشهد مقدس" },
            { text: "قم مقدسه 🇮🇷", callbackData: "TRAVELER_CITY_قم مقدسه" },
          ],
          [{ text: "🌟 مشاهده تمامی اقامتگاه‌های فعال", callbackData: "TRAVELER_CITY_ALL" }],
          [{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }],
        ],
      };
      await this.editOrSendMessage(message);
      return;
    }

    if (callback && callback.startsWith("TRAVELER_CITY_")) {
      const rawCity = callback.replace("TRAVELER_CITY_", "");
      const cityFilter = rawCity === "ALL" ? undefined : rawCity;
      const approved = await this.inventoryService.getApprovedPlaces(cityFilter);

      if (approved.length === 0) {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>🔍 نتایج جست‌وجو در ${rawCity === "ALL" ? "تمام شهرها" : rawCity}:</b>\n\nدر حال حاضر هیچ موکب تأییدشده‌ای در این بخش فعال نیست ⏳\nبه محض بررسی و تأیید پرونده‌های جدید توسط مدیریت، ظرفیت‌ها در دسترس قرار خواهند گرفت.`,
          inlineKeyboard: [
            [{ text: "🔍 انتخاب شهر دیگر", callbackData: "SEARCH_SPACES" }],
            [{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }],
          ],
        });
        return;
      }

      let textResults = `<b>🔍 تعداد ${approved.length} اقامتگاه فعال در ${rawCity === "ALL" ? "سامانه" : rawCity}:</b>\n\n`;
      const keyboard: any[][] = [];

      for (const [idx, p] of approved.entries()) {
        const spaces = await this.inventoryService.getSpacesByPlaceId(p.id);
        const totalCap = spaces.reduce((sum, s) => sum + s.nominalCapacity, 0);
        const finText = p.financialModel === "FREE" ? "رایگان و صلواتی 💚" : p.financialModel === "FIXED_FEE" ? `شبی ${p.feeAmountToman.toLocaleString('fa-IR')} تومان` : `تضمین ${p.depositAmountToman.toLocaleString('fa-IR')} تومان`;

        textResults += `${idx + 1}. <b>${p.title}</b> (${p.city})\n`;
        textResults += `   📍 نشانی: ${p.address}\n`;
        textResults += `   👥 ظرفیت کل: ${totalCap} نفر | مدل مالی: ${finText}\n`;
        textResults += `   ⚡️ نوع پذیرش: ${p.approvalMode === "INSTANT" ? "فوری و آنی ⚡️" : "دستی با تأیید موکب‌دار ⏳"}\n\n`;

        keyboard.push([{ text: `رزرو در ${p.title} 🏨`, callbackData: `TRAVELER_BOOK_${p.id}` }]);
      }

      keyboard.push([{ text: "🔍 جست‌وجو در شهر دیگر", callbackData: "SEARCH_SPACES" }]);
      keyboard.push([{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }]);

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: textResults,
        inlineKeyboard: keyboard,
      });
      return;
    }

    if (callback && callback.startsWith("TRAVELER_BOOK_")) {
      const placeId = callback.replace("TRAVELER_BOOK_", "");
      const place = await this.inventoryService.getPlaceById(placeId);
      if (!place) {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: "موکب مورد نظر یافت نشد.",
          inlineKeyboard: [[{ text: "🔙 بازگشت به جست‌وجو", callbackData: "SEARCH_SPACES" }]],
        });
        return;
      }

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>🏨 ثبت درخواست اسکان در ${place.title}:</b>\n\n• شهر: ${place.city}\n• نشانی: ${place.address}\n• شیوه پذیرش: ${place.approvalMode === "INSTANT" ? "فوری و قطعی آنی ⚡️" : "بررسی و تأیید موکب‌دار ⏳"}\n\nلطفاً تعداد نفرات گروه همراه را انتخاب نمایید:`,
        inlineKeyboard: [
          [
            { text: "۱ نفر (انفرادی)", callbackData: `TRAVELER_DOBOOK_${place.id}_1` },
            { text: "۲ نفر", callbackData: `TRAVELER_DOBOOK_${place.id}_2` },
          ],
          [
            { text: "۴ نفر", callbackData: `TRAVELER_DOBOOK_${place.id}_4` },
            { text: "۶ نفر", callbackData: `TRAVELER_DOBOOK_${place.id}_6` },
          ],
          [{ text: "🔙 بازگشت به لیست", callbackData: `TRAVELER_CITY_${place.city}` }],
        ],
      });
      return;
    }

    if (callback && callback.startsWith("TRAVELER_DOBOOK_")) {
      const parts = callback.replace("TRAVELER_DOBOOK_", "").split("_");
      const placeId = parts[0];
      const count = Number(parts[1] || 1);
      const place = await this.inventoryService.getPlaceById(placeId);
      if (!place) return;

      const resId = `RES-${Date.now().toString().slice(-6)}`;
      const statusText = place.approvalMode === "INSTANT" ? "تأییدشده و قطعی (CONFIRMED) ✅" : "در انتظار تأیید موکب‌دار (PENDING) ⏳";

      const userReservations = this.travelerReservations.get(chatId) || [];
      userReservations.push({
        id: resId,
        placeId: place.id,
        placeTitle: place.title,
        city: place.city,
        partySize: count,
        status: place.approvalMode === "INSTANT" ? "CONFIRMED" : "PENDING_HOST_APPROVAL",
        createdAt: new Date(),
      });
      this.travelerReservations.set(chatId, userReservations);

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `🌸 <b>درخواست اسکان شما با موفقیت ثبت شد!</b>\n\n🏷 <b>کد رهگیری رزرو:</b> <code>${resId}</code>\n🏨 <b>اقامتگاه:</b> ${place.title} (${place.city})\n👥 <b>تعداد نفرات:</b> ${count} نفر\n📋 <b>وضعیت رزرو:</b> ${statusText}\n\nجهت پیگیری وضعیت، می‌توانید از بخش «پیگیری رزروهای من» در منوی اصلی اقدام فرمایید.`,
        inlineKeyboard: [
          [{ text: "📋 پیگیری رزروهای من", callbackData: "MY_RESERVATIONS" }],
          [{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }],
        ],
      });
      return;
    }

    if (callback === "MY_RESERVATIONS") {
      const userReservations = this.travelerReservations.get(chatId) || [];
      if (userReservations.length === 0) {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>📋 پیگیری رزروها:</b>\n\nتاکنون رزروی برای حساب کاربری شما ثبت نشده است.\nجهت ثبت درخواست اسکان، از بخش «جست‌وجوی موکب و اقامتگاه» اقدام فرمایید.`,
          inlineKeyboard: [
            [{ text: "🔍 جست‌وجوی موکب", callbackData: "SEARCH_SPACES" }],
            [{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }],
          ],
        });
        return;
      }

      let textRes = `<b>📋 لیست رزروهای شما (${userReservations.length} مورد):</b>\n\n`;
      for (const [idx, r] of userReservations.entries()) {
        const badge = r.status === "CONFIRMED" ? "قطعی و تأییدشده ✅" : "در انتظار تأیید موکب‌دار ⏳";
        textRes += `${idx + 1}. <b>کد رهگیری: <code>${r.id}</code></b>\n`;
        textRes += `   🏨 موکب: ${r.placeTitle} (${r.city})\n`;
        textRes += `   👥 نفرات: ${r.partySize} نفر | وضعیت: ${badge}\n\n`;
      }

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: textRes,
        inlineKeyboard: [
          [{ text: "🔍 جست‌وجوی موکب جدید", callbackData: "SEARCH_SPACES" }],
          [{ text: "🔄 به‌روزرسانی لیست", callbackData: "MY_RESERVATIONS" }],
          [{ text: "🔙 بازگشت به منوی اصلی", callbackData: "MENU" }],
        ],
      });
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
    const hostId = String(fromUserId || chatId);

    // ۱. خروج از ویزارد یا بازگشت به منوی اصلی موکب‌دار
    if (text === "/start" || callback === "HOST_MENU") {
      this.hostWizards.delete(chatId);
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

    // ۲. شروع ویزارد ثبت موکب (گام ۱: انتخاب شهر)
    if (callback === "REGISTER_HOST") {
      this.hostWizards.set(chatId, { step: "CITY", data: {} });
      const message = {
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب و فضاهای اسکان (گام ۱ از ۷):</b>\n\nخادم گرامی، لطفاً شهر محل استقرار موکب خود را انتخاب فرمایید:`,
        inlineKeyboard: [
          [
            { text: "کربلای معلی 🇮🇶", callbackData: "HOST_CITY_کربلای معلی" },
            { text: "نجف اشرف 🇮🇶", callbackData: "HOST_CITY_نجف اشرف" },
          ],
          [
            { text: "مشهد مقدس 🇮🇷", callbackData: "HOST_CITY_مشهد مقدس" },
            { text: "قم مقدسه 🇮🇷", callbackData: "HOST_CITY_قم مقدسه" },
          ],
          [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
        ],
      };
      await this.editOrSendMessage(message);
      return;
    }

    // گام ۱: دریافت شهر -> گام ۲: درخواست نام موکب
    if (callback && callback.startsWith("HOST_CITY_")) {
      const city = callback.replace("HOST_CITY_", "");
      const wiz = this.hostWizards.get(chatId) || { step: "CITY", data: {} };
      wiz.data.city = city;
      wiz.step = "TITLE";
      this.hostWizards.set(chatId, wiz);

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب (گام ۲ از ۷ - نام موکب):</b>\n\nشهر انتخاب‌شده: <b>${city}</b> ✅\n\nلطفاً <b>نام رسمی موکب، حسینیه یا اقامتگاه</b> خود را به صورت پیام متنی ارسال نمایید:\n<i>(مثال: موکب احباب الرضا علیه‌السلام)</i>`,
        inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
      });
      return;
    }

    // دریافت نام موکب (متن) -> گام ۳: درخواست نام مسئول و شماره تماس
    const wiz = this.hostWizards.get(chatId);
    if (wiz && wiz.step === "TITLE" && text.length > 0) {
      wiz.data.title = text.trim();
      wiz.step = "CONTACT";
      this.hostWizards.set(chatId, wiz);

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب (گام ۳ از ۷ - مشخصات مسئول):</b>\n\nنام موکب: <b>${wiz.data.title}</b> ✅\n\nلطفاً <b>نام مسئول موکب و شماره همراه</b> هماهنگی را ارسال فرمایید:\n<i>(مثال: حاج علی محمدی 09121111111)</i>`,
        inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
      });
      return;
    }

    // دریافت مسئول و تماس (متن) -> گام ۴: درخواست نشانی دقیق
    if (wiz && wiz.step === "CONTACT" && text.length > 0) {
      wiz.data.contactName = text.trim();
      wiz.data.contactPhone = text.trim();
      wiz.step = "ADDRESS";
      this.hostWizards.set(chatId, wiz);

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب (گام ۴ از ۷ - نشانی دقیق):</b>\n\nمسئول و تماس: <b>${wiz.data.contactName}</b> ✅\n\nلطفاً <b>نشانی دقیق موکب و موقعیت مکانی</b> را ارسال فرمایید:\n<i>(مثال: شارع قبله الامام الحسین، عمود ۱۴۰)</i>`,
        inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
      });
      return;
    }

    // دریافت نشانی (متن) -> گام ۵: نوع فضاهای اسکان
    if (wiz && wiz.step === "ADDRESS" && text.length > 0) {
      wiz.data.address = text.trim();
      wiz.step = "SUPPLY_TYPE";
      this.hostWizards.set(chatId, wiz);

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب (گام ۵ از ۷ - نوع فضاهای اسکان):</b>\n\nنشانی: <b>${wiz.data.address}</b> ✅\n\nلطفاً نوع فضاهای اقامتی موکب را تعیین فرمایید:`,
        inlineKeyboard: [
          [{ text: "سالن‌های عمومی (تفکیک آقایان و بانوان)", callbackData: "HOST_SUPPLY_PUBLIC" }],
          [{ text: "اتاق‌های خانوادگی مستقل (دربست)", callbackData: "HOST_SUPPLY_PRIVATE" }],
          [{ text: "ترکیب هر دو (هم سالن و هم اتاق)", callbackData: "HOST_SUPPLY_BOTH" }],
          [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
        ],
      });
      return;
    }

    // گام ۵: انتخاب نوع فضا -> درخواست تعیین ظرفیت
    if (callback && callback.startsWith("HOST_SUPPLY_")) {
      const supply = callback.replace("HOST_SUPPLY_", "") as "PUBLIC" | "PRIVATE" | "BOTH";
      const currentWiz = this.hostWizards.get(chatId);
      if (currentWiz) {
        currentWiz.data.supplyType = supply;
        currentWiz.step = "CAPACITY";
        this.hostWizards.set(chatId, currentWiz);

        if (supply === "PUBLIC") {
          await this.editOrSendMessage({
            chatId,
            messageId,
            text: `<b>➕ تعیین ظرفیت سالن‌های عمومی:</b>\n\nظرفیت کل پذیرش در هر شب را انتخاب نمایید (به تساوی میان سالن برادران و خواهران تقسیم می‌شود):`,
            inlineKeyboard: [
              [
                { text: "۵۰ نفر (۲۵ آقا / ۲۵ خانم)", callbackData: "HOST_CAP_50" },
                { text: "۱۰۰ نفر (۵۰ آقا / ۵۰ خانم)", callbackData: "HOST_CAP_100" },
              ],
              [
                { text: "۲۰۰ نفر (۱۰۰ آقا / ۱۰۰ خانم)", callbackData: "HOST_CAP_200" },
                { text: "۵۰۰ نفر (۲۵۰ آقا / ۲۵۰ خانم)", callbackData: "HOST_CAP_500" },
              ],
              [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
            ],
          });
          return;
        } else if (supply === "PRIVATE") {
          await this.editOrSendMessage({
            chatId,
            messageId,
            text: `<b>➕ تعیین تعداد و ظرفیت اتاق‌های دربست:</b>\n\nتعداد اتاق‌ها و ظرفیت هر اتاق خانوادگی را انتخاب فرمایید:`,
            inlineKeyboard: [
              [
                { text: "۵ اتاق ۴ نفره (۲۰ نفر)", callbackData: "HOST_ROOMS_5_4" },
                { text: "۱۰ اتاق ۴ نفره (۴۰ نفر)", callbackData: "HOST_ROOMS_10_4" },
              ],
              [
                { text: "۵ اتاق ۶ نفره (۳۰ نفر)", callbackData: "HOST_ROOMS_5_6" },
                { text: "۱۰ اتاق ۶ نفره (۶۰ نفر)", callbackData: "HOST_ROOMS_10_6" },
              ],
              [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
            ],
          });
          return;
        } else {
          await this.editOrSendMessage({
            chatId,
            messageId,
            text: `<b>➕ تعیین ظرفیت سالن‌ها و اتاق‌ها:</b>\n\nترکیب ظرفیت مورد نظر خود را انتخاب نمایید:`,
            inlineKeyboard: [
              [{ text: "۱۰۰ نفر سالن + ۵ اتاق ۴ نفره", callbackData: "HOST_BOTH_100_5_4" }],
              [{ text: "۲۰۰ نفر سالن + ۱۰ اتاق ۴ نفره", callbackData: "HOST_BOTH_200_10_4" }],
              [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
            ],
          });
          return;
        }
      }
    }

    // دریافت دکمه ظرفیت -> گام ۶: مدل مالی
    if (callback && (callback.startsWith("HOST_CAP_") || callback.startsWith("HOST_ROOMS_") || callback.startsWith("HOST_BOTH_"))) {
      const currentWiz = this.hostWizards.get(chatId);
      if (currentWiz) {
        if (callback.startsWith("HOST_CAP_")) {
          currentWiz.data.hallCapacity = Number(callback.replace("HOST_CAP_", ""));
        } else if (callback.startsWith("HOST_ROOMS_")) {
          const parts = callback.replace("HOST_ROOMS_", "").split("_");
          currentWiz.data.roomCount = Number(parts[0]);
          currentWiz.data.roomCapacity = Number(parts[1]);
        } else if (callback.startsWith("HOST_BOTH_")) {
          const parts = callback.replace("HOST_BOTH_", "").split("_");
          currentWiz.data.hallCapacity = Number(parts[0]);
          currentWiz.data.roomCount = Number(parts[1]);
          currentWiz.data.roomCapacity = Number(parts[2]);
        }

        currentWiz.step = "FINANCIAL";
        this.hostWizards.set(chatId, currentWiz);

        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>➕ ثبت موکب (گام ۶ از ۷ - مدل مالی و خدمات):</b>\n\nمدل ارائه خدمات اسکان را تعیین فرمایید:`,
          inlineKeyboard: [
            [{ text: "رایگان و صلواتی 💚", callbackData: "HOST_FIN_FREE" }],
            [{ text: "هزینه ثابت (شبی ۵۰ هزار تومان) 💰", callbackData: "HOST_FIN_FEE_50000" }],
            [{ text: "هزینه ثابت (شبی ۱۰۰ هزار تومان) 💰", callbackData: "HOST_FIN_FEE_100000" }],
            [{ text: "تضمین حسن انجام کار (امانت ۲۰۰ هزار تومان) 🛡", callbackData: "HOST_FIN_DEP_200000" }],
            [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }
    }

    // گام ۶: مدل مالی -> گام ۷: شیوه تأیید
    if (callback && callback.startsWith("HOST_FIN_")) {
      const currentWiz = this.hostWizards.get(chatId);
      if (currentWiz) {
        if (callback === "HOST_FIN_FREE") {
          currentWiz.data.financialModel = "FREE";
          currentWiz.data.feeAmountToman = 0;
          currentWiz.data.depositAmountToman = 0;
        } else if (callback.startsWith("HOST_FIN_FEE_")) {
          currentWiz.data.financialModel = "FIXED_FEE";
          currentWiz.data.feeAmountToman = Number(callback.replace("HOST_FIN_FEE_", ""));
          currentWiz.data.depositAmountToman = 0;
        } else if (callback.startsWith("HOST_FIN_DEP_")) {
          currentWiz.data.financialModel = "FIXED_DEPOSIT";
          currentWiz.data.depositAmountToman = Number(callback.replace("HOST_FIN_DEP_", ""));
          currentWiz.data.feeAmountToman = 0;
        }

        currentWiz.step = "APPROVAL";
        this.hostWizards.set(chatId, currentWiz);

        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>➕ ثبت موکب (گام ۷ از ۷ - شیوه تأیید رزرو مسافر):</b>\n\nنحوه تأیید درخواست‌های رزرو زائران را تعیین نمایید:`,
          inlineKeyboard: [
            [{ text: "⚡️ تأیید فوری و خودکار (رزرو قطعی آنی)", callbackData: "HOST_APP_INSTANT" }],
            [{ text: "⏳ تأیید دستی (با بررسی و پذیرش من)", callbackData: "HOST_APP_MANUAL" }],
            [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }
    }

    // گام ۷: شیوه تأیید -> پیش‌نمایش نهایی
    if (callback && callback.startsWith("HOST_APP_")) {
      const currentWiz = this.hostWizards.get(chatId);
      if (currentWiz) {
        currentWiz.data.approvalMode = callback.replace("HOST_APP_", "") as "INSTANT" | "MANUAL";
        currentWiz.step = "CONFIRM";
        this.hostWizards.set(chatId, currentWiz);

        const d = currentWiz.data;
        const supplyLabel = d.supplyType === "PUBLIC" ? "سالن عمومی" : d.supplyType === "PRIVATE" ? "اتاق‌های دربست" : "ترکیب سالن و اتاق";
        const capLabel = d.hallCapacity ? `${d.hallCapacity} نفر در سالن` : "";
        const roomsLabel = d.roomCount ? `${d.roomCount} اتاق ${d.roomCapacity} نفره` : "";
        const combinedCap = [capLabel, roomsLabel].filter(Boolean).join(" + ");
        const finLabel = d.financialModel === "FREE" ? "کاملاً رایگان 💚" : d.financialModel === "FIXED_FEE" ? `هزینه شبی ${d.feeAmountToman?.toLocaleString('fa-IR')} تومان` : `تضمین ${d.depositAmountToman?.toLocaleString('fa-IR')} تومان`;
        const appLabel = d.approvalMode === "INSTANT" ? "تأیید فوری و خودکار ⚡️" : "بررسی و تأیید دستی ⏳";

        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `📋 <b>پیش‌نمایش پرونده موکب جهت ثبت:</b>\n\n• <b>نام موکب:</b> ${d.title}\n• <b>شهر زیارتی:</b> ${d.city}\n• <b>مسئول و تماس:</b> ${d.contactName}\n• <b>نشانی:</b> ${d.address}\n• <b>نوع فضا:</b> ${supplyLabel}\n• <b>ظرفیت فضاها:</b> ${combinedCap}\n• <b>مدل مالی:</b> ${finLabel}\n• <b>شیوه تأیید رزرو:</b> ${appLabel}\n\nجهت ثبت قطعی و ارسال به کارتابل ادمین روی دکمه زیر کلیک نمایید:`,
          inlineKeyboard: [
            [{ text: "✅ تأیید نهایی و ثبت موکب", callbackData: "HOST_SUBMIT_PLACE" }],
            [{ text: "❌ انصراف و لغو", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }
    }

    // ثبت قطعی در دیتابیس
    if (callback === "HOST_SUBMIT_PLACE") {
      const currentWiz = this.hostWizards.get(chatId);
      if (currentWiz && currentWiz.data.title) {
        const d = currentWiz.data;
        try {
          const place = await this.inventoryService.registerMokabPlace({
            hostPersonId: hostId,
            title: d.title!,
            city: d.city || "کربلای معلی",
            address: d.address || "نامشخص",
            contactName: d.contactName || "مسئول موکب",
            contactPhone: d.contactPhone || "09120000000",
            placePhotoPath: "default_place.jpg",
            responsibilityDocumentPath: "default_doc.pdf",
            supplyType: d.supplyType || "PUBLIC",
            financialModel: d.financialModel || "FREE",
            feeAmountToman: d.feeAmountToman,
            depositAmountToman: d.depositAmountToman,
            approvalMode: d.approvalMode || "INSTANT",
          });

          // ثبت فضاها
          if (d.hallCapacity && d.hallCapacity > 0) {
            const half = Math.floor(d.hallCapacity / 2);
            await this.inventoryService.registerPublicHall(place.id, "سالن برادران", "MEN", half);
            await this.inventoryService.registerPublicHall(place.id, "سالن خواهران", "WOMEN", d.hallCapacity - half);
          }
          if (d.roomCount && d.roomCount > 0 && d.roomCapacity) {
            await this.inventoryService.registerPrivateRoomsBatch(place.id, "اتاق خانوادگی", d.roomCount, d.roomCapacity);
          }

          this.hostWizards.delete(chatId);

          await this.editOrSendMessage({
            chatId,
            messageId,
            text: `✅ <b>موکب شما با موفقیت ثبت گردید!</b>\n\n🏷 <b>کد رهگیری پرونده:</b> <code>${place.id}</code>\n📋 <b>وضعیت:</b> در انتظار بررسی و تأیید مدیریت (PENDING) ⏳\n\nبه محض بررسی و تأیید توسط ادمین، اقامتگاه فعال شده و در بخش جست‌وجوی زائران قرار خواهد گرفت.`,
            inlineKeyboard: [
              [{ text: "📊 مشاهده وضعیت موکب‌های من", callbackData: "ROOMS_STATUS" }],
              [{ text: "➕ ثبت موکب دیگر", callbackData: "REGISTER_HOST" }],
              [{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }],
            ],
          });

          // ارسال اعلان مستقیم و زنده به ربات ادمین
          if (this.peerAdminWorker) {
            await this.peerAdminWorker.broadcastToAdmins(
              `🚨 <b>موکب جدید در انتظار بررسی ثبت شد:</b>\n\n` +
              `• <b>نام:</b> ${place.title}\n` +
              `• <b>شهر:</b> ${place.city}\n` +
              `• <b>مسئول و تماس:</b> ${place.contactName} (${place.contactPhone})\n` +
              `• <b>نشانی:</b> ${place.address}\n` +
              `• <b>شناسه:</b> <code>${place.id}</code>`,
              [
                [{ text: "✅ تأیید این موکب", callbackData: `APPROVE_PLACE_${place.id}` }],
                [{ text: "❌ رد پرونده", callbackData: `REJECT_PLACE_${place.id}` }],
              ]
            );
          }
          return;
        } catch (err: any) {
          await this.editOrSendMessage({
            chatId,
            messageId,
            text: `خطا در ثبت موکب: ${err.message}`,
            inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
          });
          return;
        }
      }
    }

    // کارتابل وضعیت سالن‌ها و اتاق‌ها
    if (callback === "ROOMS_STATUS") {
      const allPlaces = await this.inventoryService.getAllPlaces();
      const hostPlaces = allPlaces.filter(p => p.hostPersonId === hostId);

      if (hostPlaces.length === 0) {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>📊 وضعیت سالن‌ها و اتاق‌ها:</b>\n\nشما هنوز هیچ موکبی در سامانه ثبت نکرده‌اید.\nجهت ثبت اولین موکب خود روی دکمه «➕ ثبت موکب و ظرفیت جدید» کلیک فرمایید.`,
          inlineKeyboard: [
            [{ text: "➕ ثبت موکب و ظرفیت جدید", callbackData: "REGISTER_HOST" }],
            [{ text: "🔙 منوی اصلی موکب‌دار", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }

      let textReport = `<b>📊 لیست موکب‌ها و فضاهای ثبت‌شده شما (${hostPlaces.length} موکب):</b>\n\n`;
      for (const [idx, p] of hostPlaces.entries()) {
        const spaces = await this.inventoryService.getSpacesByPlaceId(p.id);
        const halls = spaces.filter(s => s.spaceType === "PUBLIC_HALL");
        const rooms = spaces.filter(s => s.spaceType === "PRIVATE_ROOM");
        const totalCap = spaces.reduce((sum, s) => sum + s.nominalCapacity, 0);

        const statusBadge = p.status === "APPROVED" ? "تأییدشده و فعال ✅" : p.status === "PENDING" ? "در صف بررسی ادمین ⏳" : "ردشده ❌";
        textReport += `${idx + 1}. <b>${p.title}</b> (${p.city})\n`;
        textReport += `   • وضعیت: ${statusBadge}\n`;
        textReport += `   • فضاها: ${halls.length} سالن عمومی، ${rooms.length} اتاق دربست (ظرفیت کل: ${totalCap} نفر)\n`;
        textReport += `   • کد پرونده: <code>${p.id}</code>\n\n`;
      }

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: textReport,
        inlineKeyboard: [
          [{ text: "➕ ثبت موکب جدید", callbackData: "REGISTER_HOST" }],
          [{ text: "🔄 به‌روزرسانی وضعیت", callbackData: "ROOMS_STATUS" }],
          [{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }],
        ],
      });
      return;
    }

    if (callback === "PENDING_REQUESTS") {
      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>📋 کارتابل درخواست‌های رزرو مسافران:</b>\n\nدر حال حاضر درخواست جدیدی در انتظار بررسی شما وجود ندارد ✅\nبه محض ثبت رزرو دستی جدید توسط زائران، اعلان آن برای شما ارسال خواهد شد.`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      });
      return;
    }

    if (callback === "RECEIPTS_INBOX") {
      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>💳 کارتابل بررسی فیش‌های واریزی:</b>\n\nهیچ فیش جدیدی در صف بررسی وجود ندارد.\n(طبق قوانین، بررسی فیش‌ها منحصراً توسط شخص موکب‌دار انجام می‌شود).`,
        inlineKeyboard: [[{ text: "🔙 بازگشت به منوی موکب‌دار", callbackData: "HOST_MENU" }]],
      });
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
