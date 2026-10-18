/**
 * آداپتورهای پیام‌رسان تلگرام و بله و مدیریت تکرار (Idempotency)
 * انطباق با: DEC-0003, DEC-0015, DEC-0016
 */

import { ChannelType } from '../core/types';
import {
  BotRole,
  ChannelAdapter,
  InboundMessage,
  InlineButton,
  OutboundMessage,
  TelegramInlineKeyboardButton,
  BaleInlineKeyboardButton,
} from './types';

/**
 * مدیریت حذف پیام‌ها و کلیک‌های تکراری (Deduplication / Idempotency)
 */
export class MessageDeduplicator {
  private processedKeys = new Map<string, number>(); // key -> expiresAt timestamp
  private defaultTtlMs: number;

  constructor(defaultTtlMs: number = 3600000) { // پیش‌فرض ۱ ساعت
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * آیا این کلید قبلاً پردازش شده و معتبر است؟
   */
  isDuplicate(key: string): boolean {
    const now = Date.now();
    const expiresAt = this.processedKeys.get(key);
    if (!expiresAt) {
      return false;
    }
    if (now > expiresAt) {
      this.processedKeys.delete(key);
      return false;
    }
    return true;
  }

  /**
   * ثبت کلید به عنوان پردازش‌شده
   */
  markProcessed(key: string, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.processedKeys.set(key, Date.now() + ttl);
  }

  /**
   * پاکسازی کلیدهای منقضی‌شده
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.processedKeys.entries()) {
      if (now > expiresAt) {
        this.processedKeys.delete(key);
      }
    }
  }

  clear(): void {
    this.processedKeys.clear();
  }
}

/**
 * آداپتور پیام‌رسان تلگرام (DEC-0003)
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'TELEGRAM';
  private deduplicator: MessageDeduplicator;
  private networkFailureSimulator: boolean = false;

  constructor(deduplicator?: MessageDeduplicator) {
    this.deduplicator = deduplicator ?? new MessageDeduplicator();
  }

  setSimulateFailure(fail: boolean): void {
    this.networkFailureSimulator = fail;
  }

  /**
   * تبدیل آپدیت یا پیام خام تلگرام به پیام ورودی نرمال‌شده
   */
  normalizeInbound(rawPayload: any, botRole: BotRole): InboundMessage {
    let messageId = '';
    let chatId = '';
    let fromUserId = '';
    let text: string | undefined;
    let callbackData: string | undefined;
    let photoUrlOrFileId: string | undefined;
    let phoneNumber: string | undefined;

    if (rawPayload.callback_query) {
      const cb = rawPayload.callback_query;
      messageId = String(cb.id || (cb.message ? cb.message.message_id : ''));
      chatId = String(cb.message?.chat?.id || cb.from?.id || '');
      fromUserId = String(cb.from?.id || '');
      callbackData = cb.data;
    } else if (rawPayload.message) {
      const msg = rawPayload.message;
      messageId = String(msg.message_id || '');
      chatId = String(msg.chat?.id || '');
      fromUserId = String(msg.from?.id || '');
      text = msg.text;
      if (msg.contact?.phone_number) {
        phoneNumber = msg.contact.phone_number;
      }
      if (Array.isArray(msg.photo) && msg.photo.length > 0) {
        // آخرین عنصر بزرگ‌ترین اندازه عکس در تلگرام است
        photoUrlOrFileId = msg.photo[msg.photo.length - 1].file_id;
      }
    } else {
      // فرمت عمومی
      messageId = String(rawPayload.update_id || rawPayload.id || Date.now());
      chatId = String(rawPayload.chat_id || '');
      fromUserId = String(rawPayload.user_id || '');
      text = rawPayload.text;
    }

    const idempotencyKey = `TELEGRAM:${botRole}:${rawPayload.update_id || messageId}:${callbackData || 'MSG'}`;

    return {
      idempotencyKey,
      channel: 'TELEGRAM',
      botRole,
      messageId,
      chatId,
      fromUserId,
      text,
      callbackData,
      photoUrlOrFileId,
      phoneNumber,
      timestamp: new Date(),
    };
  }

  /**
   * تبدیل پیام خروجی به فرمت استاندارد Bot API تلگرام
   */
  formatOutbound(message: OutboundMessage): any {
    const payload: any = {
      chat_id: message.chatId,
      text: message.text,
      parse_mode: 'HTML',
    };

    if (message.inlineKeyboard && message.inlineKeyboard.length > 0) {
      const telegramKeyboard: TelegramInlineKeyboardButton[][] = message.inlineKeyboard.map(row =>
        row.map(btn => {
          const tBtn: TelegramInlineKeyboardButton = { text: btn.text };
          if (btn.callbackData) {
            tBtn.callback_data = btn.callbackData;
          }
          if (btn.url) {
            tBtn.url = btn.url;
          }
          if (btn.webAppUrl) {
            tBtn.web_app = { url: btn.webAppUrl };
          }
          return tBtn;
        })
      );
      payload.reply_markup = { inline_keyboard: telegramKeyboard };
    }

    return payload;
  }

  /**
   * ارسال امن بدون شکستن تراکنش بیزینس (DEC-0016)
   */
  async sendOutbound(message: OutboundMessage): Promise<boolean> {
    if (this.networkFailureSimulator) {
      // شبیه‌سازی قطعی یا خطای درگاه پیام‌رسان
      return false;
    }
    // در محیط واقعی یا آزمون محلی، با موفقیت انجام می‌شود
    return true;
  }
}

/**
 * آداپتور پیام‌رسان بله (DEC-0003)
 */
export class BaleAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'BALE';
  private deduplicator: MessageDeduplicator;
  private networkFailureSimulator: boolean = false;

  constructor(deduplicator?: MessageDeduplicator) {
    this.deduplicator = deduplicator ?? new MessageDeduplicator();
  }

  setSimulateFailure(fail: boolean): void {
    this.networkFailureSimulator = fail;
  }

  /**
   * تبدیل آپدیت یا پیام خام بله به پیام ورودی نرمال‌شده
   */
  normalizeInbound(rawPayload: any, botRole: BotRole): InboundMessage {
    let messageId = '';
    let chatId = '';
    let fromUserId = '';
    let text: string | undefined;
    let callbackData: string | undefined;
    let photoUrlOrFileId: string | undefined;
    let phoneNumber: string | undefined;

    if (rawPayload.callback_query) {
      const cb = rawPayload.callback_query;
      messageId = String(cb.id || (cb.message ? cb.message.message_id : ''));
      chatId = String(cb.message?.chat?.id || cb.from?.id || '');
      fromUserId = String(cb.from?.id || '');
      callbackData = cb.data;
    } else if (rawPayload.message) {
      const msg = rawPayload.message;
      messageId = String(msg.message_id || '');
      chatId = String(msg.chat?.id || '');
      fromUserId = String(msg.from?.id || '');
      text = msg.text;
      if (msg.contact?.phone_number) {
        phoneNumber = msg.contact.phone_number;
      }
      if (Array.isArray(msg.photo) && msg.photo.length > 0) {
        photoUrlOrFileId = msg.photo[msg.photo.length - 1].file_id;
      }
    } else {
      messageId = String(rawPayload.update_id || rawPayload.id || Date.now());
      chatId = String(rawPayload.chat_id || '');
      fromUserId = String(rawPayload.user_id || '');
      text = rawPayload.text;
    }

    const idempotencyKey = `BALE:${botRole}:${rawPayload.update_id || messageId}:${callbackData || 'MSG'}`;

    return {
      idempotencyKey,
      channel: 'BALE',
      botRole,
      messageId,
      chatId,
      fromUserId,
      text,
      callbackData,
      photoUrlOrFileId,
      phoneNumber,
      timestamp: new Date(),
    };
  }

  /**
   * تبدیل پیام خروجی به فرمت استاندارد Bot API بله
   */
  formatOutbound(message: OutboundMessage): any {
    const payload: any = {
      chat_id: message.chatId,
      text: message.text,
    };

    if (message.inlineKeyboard && message.inlineKeyboard.length > 0) {
      const baleKeyboard: BaleInlineKeyboardButton[][] = message.inlineKeyboard.map(row =>
        row.map(btn => {
          const bBtn: BaleInlineKeyboardButton = { text: btn.text };
          if (btn.callbackData) {
            bBtn.callback_data = btn.callbackData;
          }
          // در بله دکمه وب‌لینک از url استفاده می‌کند
          if (btn.url || btn.webAppUrl) {
            bBtn.url = btn.webAppUrl || btn.url;
          }
          return bBtn;
        })
      );
      payload.reply_markup = { inline_keyboard: baleKeyboard };
    }

    return payload;
  }

  /**
   * ارسال امن پیام در بله بدون شکستن تراکنش هسته (DEC-0016)
   */
  async sendOutbound(message: OutboundMessage): Promise<boolean> {
    if (this.networkFailureSimulator) {
      return false;
    }
    return true;
  }
}
