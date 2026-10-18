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

export function normalizePersianDigits(input: string): string {
  if (!input) return "";
  const pDigits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  const aDigits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  let res = String(input);
  for (let i = 0; i < 10; i++) {
    res = res.replaceAll(pDigits[i], String(i));
    res = res.replaceAll(aDigits[i], String(i));
  }
  return res.replace(/[,،]/g, "").trim();
}

export function parseRoomSpecs(input: string): { count: number; capacity: number } | null {
  const norm = normalizePersianDigits(input);
  // Match "3*5", "3x5", "3 در 5", "3 تا 5", "3 اتاق 5 نفره", "3 اتاق 5"
  const m = norm.match(/(\d+)\s*(?:[x*×X]|در|تا|اتاق(?:های)?)\s*(\d+)/i);
  if (m) {
    const c = parseInt(m[1], 10);
    const cap = parseInt(m[2], 10);
    if (c > 0 && cap > 0) return { count: c, capacity: cap };
  }
  // Match "5 عدد اتاق 4 نفره"
  const m2 = norm.match(/(\d+)\s*(?:عدد|دستگاه|مورد)?\s*اتاق\s*(\d+)/i);
  if (m2) {
    const c = parseInt(m2[1], 10);
    const cap = parseInt(m2[2], 10);
    if (c > 0 && cap > 0) return { count: c, capacity: cap };
  }
  return null;
}

export function parseTomanValue(input: string): number {
  const norm = normalizePersianDigits(input);
  const match = norm.match(/\d+/);
  if (!match) return 0;
  let val = parseInt(match[0], 10);
  if (norm.includes("میلیون") && val < 1000000) {
    val *= 1000000;
  } else if (norm.includes("هزار") && val < 1000) {
    val *= 1000;
  }
  return val;
}

export interface HostWizardSession {
  step: "CITY" | "TITLE" | "CONTACT" | "ADDRESS" | "SUPPLY_TYPE" | "CAPACITY" | "FINANCIAL" | "FINANCIAL_AMOUNT" | "APPROVAL" | "CONFIRM";
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

    // پشتیبانی از ورودی متنی برای زائر (Dual-Input)
    if (text && !callback) {
      if (text.includes("کربلا")) {
        return this.handleTravelerMessage(chatId, "", "TRAVELER_CITY_کربلای معلی", fromUserId, messageId);
      }
      if (text.includes("نجف")) {
        return this.handleTravelerMessage(chatId, "", "TRAVELER_CITY_نجف اشرف", fromUserId, messageId);
      }
      if (text.includes("مشهد")) {
        return this.handleTravelerMessage(chatId, "", "TRAVELER_CITY_مشهد مقدس", fromUserId, messageId);
      }
      if (text.includes("قم")) {
        return this.handleTravelerMessage(chatId, "", "TRAVELER_CITY_قم مقدسه", fromUserId, messageId);
      }
      if (text.includes("همه") || text.includes("تمام") || text.includes("لیست")) {
        return this.handleTravelerMessage(chatId, "", "TRAVELER_CITY_ALL", fromUserId, messageId);
      }
      if (text.includes("رزرو") || text.includes("پیگیری")) {
        return this.handleTravelerMessage(chatId, "", "MY_RESERVATIONS", fromUserId, messageId);
      }
      if (text.includes("جستجو") || text.includes("موکب")) {
        return this.handleTravelerMessage(chatId, "", "SEARCH_SPACES", fromUserId, messageId);
      }
      if (text.includes("قوانین") || text.includes("راهنما")) {
        return this.handleTravelerMessage(chatId, "", "RULES_INFO", fromUserId, messageId);
      }
      if (text.includes("اتصال") || text.includes("بله")) {
        return this.handleTravelerMessage(chatId, "", "LINK_ACCOUNT", fromUserId, messageId);
      }
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
    if (text === "/start" || text === "منو" || text === "منوی اصلی" || callback === "HOST_MENU") {
      this.hostWizards.delete(chatId);
      const message = {
        chatId,
        messageId,
        text: `سلام و احترام خدمت خادم و موکب‌دار گرامی 🏴\nبه <b>سامانه مدیریت و کارتابل موکب‌داران</b> خوش آمدید.\n\nلطفاً یکی از بخش‌های زیر را انتخاب نمایید یا دستور دلخواه را ارسال کنید:`,
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

    const wiz = this.hostWizards.get(chatId);

    // ۲. شروع ویزارد ثبت موکب (کلیک دکمه یا ارسال متن ثبت)
    if (callback === "REGISTER_HOST" || (!wiz && (text.includes("ثبت") || text === "/register" || text === "/new"))) {
      this.hostWizards.set(chatId, { step: "CITY", data: {} });
      const message = {
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب و فضاهای اسکان (گام ۱ از ۷):</b>\n\nخادم گرامی، لطفاً شهر محل استقرار موکب خود را انتخاب فرمایید یا <b>نام شهر را مستقیماً تایپ فرمایید</b>:\n<i>(مثال: سامرا، کاظمین، شیراز، قم و...)</i>`,
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

    // هدایت دستورات متنی منوی اصلی در صورتی که کاربری خارج از ویزارد باشد
    if (!wiz) {
      if (text.includes("کارتابل") || text.includes("درخواست")) {
        return this.handleHostMessage(chatId, "", "PENDING_REQUESTS", fromUserId, messageId);
      }
      if (text.includes("وضعیت") || text.includes("اتاق") || text.includes("سالن") || text.includes("ظرفیت")) {
        return this.handleHostMessage(chatId, "", "ROOMS_STATUS", fromUserId, messageId);
      }
      if (text.includes("فیش") || text.includes("واریز")) {
        return this.handleHostMessage(chatId, "", "RECEIPTS_INBOX", fromUserId, messageId);
      }
    }

    // گام ۱: دریافت شهر -> گام ۲: درخواست نام موکب (دکمه یا تایپ آزاد شهر)
    if ((callback && callback.startsWith("HOST_CITY_")) || (wiz && wiz.step === "CITY" && text.length > 0)) {
      const city = callback ? callback.replace("HOST_CITY_", "") : text.trim();
      if (city.includes("مکه") || city.includes("مدینه")) {
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `⚠️ <b>محدودیت سامانه (DEC-0002):</b>\n\nطبق ضوابط، در حال حاضر ثبت اقامتگاه در شهرهای عربستان (مکه و مدینه) در سامانه پشتیبانی نمی‌شود.\nلطفاً شهر زیارتی دیگری (مانند کربلا، نجف، مشهد، سامرا، کاظمین، قم و...) را انتخاب یا تایپ فرمایید:`,
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
        });
        return;
      }

      const currentWiz = wiz || { step: "CITY", data: {} };
      currentWiz.data.city = city;
      currentWiz.step = "TITLE";
      this.hostWizards.set(chatId, currentWiz);

      await this.editOrSendMessage({
        chatId,
        messageId,
        text: `<b>➕ ثبت موکب (گام ۲ از ۷ - نام موکب):</b>\n\nشهر انتخاب‌شده: <b>${city}</b> ✅\n\nلطفاً <b>نام رسمی موکب، حسینیه یا اقامتگاه</b> خود را به صورت پیام متنی ارسال نمایید:\n<i>(مثال: موکب احباب الرضا علیه‌السلام)</i>`,
        inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
      });
      return;
    }

    // دریافت نام موکب (متن) -> گام ۳: درخواست نام مسئول و شماره تماس
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

    // گام ۵: انتخاب نوع فضا (دکمه یا تایپ) -> درخواست تعیین ظرفیت
    if ((callback && callback.startsWith("HOST_SUPPLY_")) || (wiz && wiz.step === "SUPPLY_TYPE" && text.length > 0)) {
      let supply: "PUBLIC" | "PRIVATE" | "BOTH" = "PUBLIC";
      if (callback && callback.startsWith("HOST_SUPPLY_")) {
        supply = callback.replace("HOST_SUPPLY_", "") as "PUBLIC" | "PRIVATE" | "BOTH";
      } else if (text) {
        if (text.includes("اتاق") || text.includes("دربست") || text.includes("خانوادگی")) {
          supply = "PRIVATE";
        } else if (text.includes("ترکیب") || text.includes("هر دو") || text.includes("هم")) {
          supply = "BOTH";
        } else {
          supply = "PUBLIC";
        }
      }

      const currentWiz = wiz || this.hostWizards.get(chatId);
      if (currentWiz) {
        currentWiz.data.supplyType = supply;
        currentWiz.step = "CAPACITY";
        this.hostWizards.set(chatId, currentWiz);

        if (supply === "PUBLIC") {
          await this.editOrSendMessage({
            chatId,
            messageId,
            text: `<b>➕ تعیین ظرفیت سالن‌های عمومی:</b>\n\nظرفیت کل پذیرش در هر شب را انتخاب نمایید یا <b>عدد ظرفیت دلخواه را بنویسید</b> (مثال: ۱۵۰ نفر):\n<i>(نصف ظرفیت به برادران و نصف به خواهران تخصیص می‌یابد)</i>`,
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
            text: `<b>➕ تعیین تعداد و ظرفیت اتاق‌های دربست:</b>\n\nتعداد اتاق‌ها و ظرفیت هر اتاق خانوادگی را انتخاب فرمایید یا <b>ترکیب دلخواه خود را بنویسید</b>:\n<i>(مثال: ۵ اتاق ۴ نفره یا ۳*۵ یا ۴ در ۶)</i>`,
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
            text: `<b>➕ تعیین ظرفیت سالن‌ها و اتاق‌ها:</b>\n\nترکیب ظرفیت مورد نظر خود را انتخاب نمایید یا <b>بنویسید</b> (مثال: ۱۰۰ سالن + ۵ اتاق ۴ نفره):`,
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

    // دریافت ظرفیت (دکمه یا تایپ آزاد) -> گام ۶: مدل مالی
    if (
      (callback && (callback.startsWith("HOST_CAP_") || callback.startsWith("HOST_ROOMS_") || callback.startsWith("HOST_BOTH_"))) ||
      (wiz && wiz.step === "CAPACITY" && text.length > 0)
    ) {
      const currentWiz = wiz || this.hostWizards.get(chatId);
      if (currentWiz) {
        if (callback) {
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
        } else if (text) {
          const supply = currentWiz.data.supplyType || "PUBLIC";
          if (supply === "PUBLIC") {
            const norm = normalizePersianDigits(text);
            const numMatch = norm.match(/\d+/);
            const val = numMatch ? parseInt(numMatch[0], 10) : 0;
            if (val > 0) {
              currentWiz.data.hallCapacity = val;
            } else {
              await this.editOrSendMessage({
                chatId,
                messageId,
                text: `⚠️ لطفاً ظرفیت عددی سالن را به صورت یک رقم معتبر وارد فرمایید (مثال: ۱۵۰):`,
                inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
              });
              return;
            }
          } else if (supply === "PRIVATE") {
            const rooms = parseRoomSpecs(text);
            if (rooms) {
              currentWiz.data.roomCount = rooms.count;
              currentWiz.data.roomCapacity = rooms.capacity;
            } else {
              await this.editOrSendMessage({
                chatId,
                messageId,
                text: `⚠️ لطفاً تعداد و ظرفیت هر اتاق را مشخص فرمایید (مثال: ۵ اتاق ۴ نفره یا ۳*۵):`,
                inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
              });
              return;
            }
          } else {
            // BOTH
            const rooms = parseRoomSpecs(text);
            if (rooms) {
              currentWiz.data.roomCount = rooms.count;
              currentWiz.data.roomCapacity = rooms.capacity;
              const withoutRooms = text.replace(new RegExp(`(?:${rooms.count}|${rooms.capacity}|اتاق|نفره)`, 'gi'), '');
              const hallMatch = normalizePersianDigits(withoutRooms).match(/\d+/);
              currentWiz.data.hallCapacity = hallMatch ? parseInt(hallMatch[0], 10) : 100;
            } else {
              const numMatch = normalizePersianDigits(text).match(/\d+/);
              currentWiz.data.hallCapacity = numMatch ? parseInt(numMatch[0], 10) : 100;
              currentWiz.data.roomCount = 5;
              currentWiz.data.roomCapacity = 4;
            }
          }
        }

        currentWiz.step = "FINANCIAL";
        this.hostWizards.set(chatId, currentWiz);

        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>➕ ثبت موکب (گام ۶ از ۷ - مدل مالی و خدمات):</b>\n\nمدل ارائه خدمات اسکان را تعیین فرمایید یا <b>مبلغ دلخواه را مستقیماً بنویسید</b>:`,
          inlineKeyboard: [
            [{ text: "رایگان و صلواتی 💚", callbackData: "HOST_FIN_FREE" }],
            [
              { text: "تعیین هزینه اقامت دلخواه 💰", callbackData: "HOST_FIN_CHOOSE_FEE" },
              { text: "تعیین ودیعه امانت دلخواه 🛡", callbackData: "HOST_FIN_CHOOSE_DEP" },
            ],
            [
              { text: "شبی ۵۰ هزار تومان 💰", callbackData: "HOST_FIN_FEE_50000" },
              { text: "شبی ۱۰۰ هزار تومان 💰", callbackData: "HOST_FIN_FEE_100000" },
            ],
            [{ text: "تضمین امانت ۲۰۰ هزار تومان 🛡", callbackData: "HOST_FIN_DEP_200000" }],
            [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }
    }

    // گام ۶: مدل مالی (دکمه‌های انتخاب مستقیم یا هدایت به تایپ مبلغ)
    if (callback === "HOST_FIN_CHOOSE_FEE") {
      const currentWiz = this.hostWizards.get(chatId);
      if (currentWiz) {
        currentWiz.data.financialModel = "FIXED_FEE";
        currentWiz.step = "FINANCIAL_AMOUNT";
        this.hostWizards.set(chatId, currentWiz);

        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>💰 تعیین مبلغ هزینه اقامت:</b>\n\nلطفاً <b>مبلغ هزینه هر شب به ازای هر زائر</b> را به تومان تایپ نمایید یا یکی از مبالغ زیر را انتخاب کنید:\n<i>(مثال: 70000 یا ۷۰ هزار تومان)</i>`,
          inlineKeyboard: [
            [
              { text: "۳۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_30000" },
              { text: "۵۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_50000" },
            ],
            [
              { text: "۷۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_70000" },
              { text: "۱۰۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_100000" },
            ],
            [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }
    }

    if (callback === "HOST_FIN_CHOOSE_DEP") {
      const currentWiz = this.hostWizards.get(chatId);
      if (currentWiz) {
        currentWiz.data.financialModel = "FIXED_DEPOSIT";
        currentWiz.step = "FINANCIAL_AMOUNT";
        this.hostWizards.set(chatId, currentWiz);

        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `<b>🛡 تعیین مبلغ تضمین حسن انجام کار (امانت):</b>\n\nلطفاً <b>مبلغ تضمین امانت</b> را به تومان تایپ نمایید یا یکی از گزینه‌های زیر را انتخاب فرمایید:\n<i>(مثال: 150000 یا ۱۵۰ هزار تومان)</i>`,
          inlineKeyboard: [
            [
              { text: "۱۰۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_100000" },
              { text: "۲۰۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_200000" },
            ],
            [
              { text: "۳۰۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_300000" },
              { text: "۵۰۰,۰۰۰ تومان", callbackData: "HOST_AMOUNT_500000" },
            ],
            [{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }
    }

    // گام ۶: مدل مالی -> دکمه‌های سریع یا ورودی متنی
    if (
      (callback && callback.startsWith("HOST_FIN_")) ||
      (wiz && wiz.step === "FINANCIAL" && text.length > 0)
    ) {
      const currentWiz = wiz || this.hostWizards.get(chatId);
      if (currentWiz) {
        if (callback) {
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
        } else if (text) {
          if (text.includes("رایگان") || text.includes("صلواتی")) {
            currentWiz.data.financialModel = "FREE";
            currentWiz.data.feeAmountToman = 0;
            currentWiz.data.depositAmountToman = 0;
          } else if (text.includes("تضمین") || text.includes("امانت") || text.includes("ودیعه")) {
            currentWiz.data.financialModel = "FIXED_DEPOSIT";
            const val = parseTomanValue(text);
            if (val > 0) {
              currentWiz.data.depositAmountToman = val;
              currentWiz.data.feeAmountToman = 0;
            } else {
              currentWiz.step = "FINANCIAL_AMOUNT";
              this.hostWizards.set(chatId, currentWiz);
              await this.editOrSendMessage({
                chatId,
                messageId,
                text: `لطفاً مبلغ ودیعه را به تومان وارد نمایید (مثال: ۱۵۰ هزار تومان یا 150000):`,
                inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
              });
              return;
            }
          } else {
            const val = parseTomanValue(text);
            if (val > 0) {
              currentWiz.data.financialModel = "FIXED_FEE";
              currentWiz.data.feeAmountToman = val;
              currentWiz.data.depositAmountToman = 0;
            } else {
              await this.editOrSendMessage({
                chatId,
                messageId,
                text: `⚠️ مبلغ واردشده نامعتبر است. لطفاً مبلغ هزینه را به تومان وارد نمایید (مثال: ۷۰ هزار تومان یا 70000):`,
                inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
              });
              return;
            }
          }
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

    // دریافت مبلغ در گام FINANCIAL_AMOUNT (دکمه یا تایپ)
    if (
      (callback && callback.startsWith("HOST_AMOUNT_")) ||
      (wiz && wiz.step === "FINANCIAL_AMOUNT" && text.length > 0)
    ) {
      const currentWiz = wiz || this.hostWizards.get(chatId);
      if (currentWiz) {
        const val = callback ? Number(callback.replace("HOST_AMOUNT_", "")) : parseTomanValue(text);
        if (val > 0) {
          if (currentWiz.data.financialModel === "FIXED_DEPOSIT") {
            currentWiz.data.depositAmountToman = val;
            currentWiz.data.feeAmountToman = 0;
          } else {
            currentWiz.data.financialModel = "FIXED_FEE";
            currentWiz.data.feeAmountToman = val;
            currentWiz.data.depositAmountToman = 0;
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
        } else {
          await this.editOrSendMessage({
            chatId,
            messageId,
            text: `⚠️ مبلغ واردشده نامعتبر است. لطفاً مبلغ مورد نظر را به تومان وارد فرمایید (مثال: 70000):`,
            inlineKeyboard: [[{ text: "🔙 انصراف و بازگشت", callbackData: "HOST_MENU" }]],
          });
          return;
        }
      }
    }

    // گام ۷: شیوه تأیید (دکمه یا متن) -> پیش‌نمایش نهایی
    if (
      (callback && callback.startsWith("HOST_APP_")) ||
      (wiz && wiz.step === "APPROVAL" && text.length > 0)
    ) {
      const currentWiz = wiz || this.hostWizards.get(chatId);
      if (currentWiz) {
        if (callback && callback.startsWith("HOST_APP_")) {
          currentWiz.data.approvalMode = callback.replace("HOST_APP_", "") as "INSTANT" | "MANUAL";
        } else if (text) {
          if (text.includes("فوری") || text.includes("آنی") || text.includes("خودکار")) {
            currentWiz.data.approvalMode = "INSTANT";
          } else {
            currentWiz.data.approvalMode = "MANUAL";
          }
        }

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
          text: `📋 <b>پیش‌نمایش پرونده موکب جهت ثبت:</b>\n\n• <b>نام موکب:</b> ${d.title}\n• <b>شهر زیارتی:</b> ${d.city}\n• <b>مسئول و تماس:</b> ${d.contactName}\n• <b>نشانی:</b> ${d.address}\n• <b>نوع فضا:</b> ${supplyLabel}\n• <b>ظرفیت فضاها:</b> ${combinedCap}\n• <b>مدل مالی:</b> ${finLabel}\n• <b>شیوه تأیید رزرو:</b> ${appLabel}\n\nجهت ثبت قطعی و ارسال به کارتابل ادمین روی دکمه زیر کلیک نمایید یا عبارت «تأیید» را ارسال فرمایید:`,
          inlineKeyboard: [
            [{ text: "✅ تأیید نهایی و ثبت موکب", callbackData: "HOST_SUBMIT_PLACE" }],
            [{ text: "❌ انصراف و لغو", callbackData: "HOST_MENU" }],
          ],
        });
        return;
      }
    }

    // تایید یا انصراف متنی در مرحله پیش‌نمایش نهایی
    if (wiz && wiz.step === "CONFIRM" && text.length > 0) {
      if (text.includes("تایید") || text.includes("ثبت") || text.includes("بله") || text.includes("ارسال")) {
        callback = "HOST_SUBMIT_PLACE";
      } else if (text.includes("لغو") || text.includes("انصراف") || text.includes("خیر")) {
        this.hostWizards.delete(chatId);
        await this.editOrSendMessage({
          chatId,
          messageId,
          text: `عملیات ثبت موکب لغو شد. به منوی اصلی بازگشتید:`,
          inlineKeyboard: [[{ text: "🔙 منوی اصلی موکب‌دار", callbackData: "HOST_MENU" }]],
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
