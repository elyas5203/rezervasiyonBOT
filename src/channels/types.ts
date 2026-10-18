/**
 * تعاریف و اینترفیس‌های لایه درگاه‌های پیام‌رسان (تلگرام و بله)
 * انطباق با: DEC-0003, DEC-0015, DEC-0016
 */

import { ChannelType } from '../core/types';

/** نقش کاربردی بات */
export type BotRole = 'TRAVELER_BOT' | 'HOST_BOT' | 'ADMIN_BOT';

/** دکمه شیشه‌ای اینلاین یکپارچه */
export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
  webAppUrl?: string; // برای وب‌ویو مرورگر مدیر (DEC-0028)
}

/** پیام ورودی نرمال‌شده از درگاه پیام‌رسان */
export interface InboundMessage {
  idempotencyKey: string;
  channel: ChannelType;
  botRole: BotRole;
  messageId: string;
  chatId: string;
  fromUserId: string;
  text?: string;
  callbackData?: string;
  photoUrlOrFileId?: string;
  phoneNumber?: string;
  timestamp: Date;
}

/** پیام خروجی ارسالی به درگاه پیام‌رسان */
export interface OutboundMessage {
  channel: ChannelType;
  chatId: string;
  text: string;
  inlineKeyboard?: InlineButton[][];
}

/** ساختار دکمه شیشه‌ای استاندارد تلگرام */
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

/** ساختار دکمه شیشه‌ای استاندارد بله */
export interface BaleInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/** اینترفیس مشترک آداپتورهای پیام‌رسان */
export interface ChannelAdapter {
  readonly channel: ChannelType;
  normalizeInbound(rawPayload: any, botRole: BotRole): InboundMessage;
  formatOutbound(message: OutboundMessage): any;
  sendOutbound(message: OutboundMessage): Promise<boolean>;
}
