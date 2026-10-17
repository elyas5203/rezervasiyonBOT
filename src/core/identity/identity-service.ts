/**
 * ماژول هویت مرکزی و پیوند حساب پیام‌رسان‌ها
 * منبع حقیقت: DEC-0003, DEC-0018, DEC-0039, DEC-0040, DEC-0043, DEC-0044
 */

import { ChannelAccount, ChannelType, LinkCode, Person } from '../types.js';
import { generateLinkCode, validateLinkCode } from '../../db/schema.js';

export interface IdentityRepository {
  findPersonById(id: string): Promise<Person | null>;
  createPerson(person: Person): Promise<Person>;
  updatePerson(person: Person): Promise<Person>;

  findChannelAccount(channelType: ChannelType, channelUserId: string): Promise<ChannelAccount | null>;
  createChannelAccount(account: ChannelAccount): Promise<ChannelAccount>;
  updateChannelAccount(account: ChannelAccount): Promise<ChannelAccount>;
  getChannelAccountsByPersonId(personId: string): Promise<ChannelAccount[]>;

  saveLinkCode(linkCode: LinkCode): Promise<LinkCode>;
  findLinkCode(code: string): Promise<LinkCode | null>;
  updateLinkCode(linkCode: LinkCode): Promise<LinkCode>;
}

/**
 * پیاده‌سازی ذخیره‌ساز در حافظه برای آزمون‌های محلی ایزوله و سریع
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  private persons: Map<string, Person> = new Map();
  private channels: Map<string, ChannelAccount> = new Map(); // key: `${channelType}:${channelUserId}`
  private linkCodes: Map<string, LinkCode> = new Map(); // key: code

  async findPersonById(id: string): Promise<Person | null> {
    return this.persons.get(id) || null;
  }

  async createPerson(person: Person): Promise<Person> {
    this.persons.set(person.id, { ...person });
    return person;
  }

  async updatePerson(person: Person): Promise<Person> {
    this.persons.set(person.id, { ...person });
    return person;
  }

  async findChannelAccount(channelType: ChannelType, channelUserId: string): Promise<ChannelAccount | null> {
    const key = `${channelType}:${channelUserId}`;
    return this.channels.get(key) || null;
  }

  async createChannelAccount(account: ChannelAccount): Promise<ChannelAccount> {
    const key = `${account.channelType}:${account.channelUserId}`;
    this.channels.set(key, { ...account });
    return account;
  }

  async updateChannelAccount(account: ChannelAccount): Promise<ChannelAccount> {
    const key = `${account.channelType}:${account.channelUserId}`;
    this.channels.set(key, { ...account });
    return account;
  }

  async getChannelAccountsByPersonId(personId: string): Promise<ChannelAccount[]> {
    return Array.from(this.channels.values()).filter(acc => acc.personId === personId);
  }

  async saveLinkCode(linkCode: LinkCode): Promise<LinkCode> {
    this.linkCodes.set(linkCode.code, { ...linkCode });
    return linkCode;
  }

  async findLinkCode(code: string): Promise<LinkCode | null> {
    return this.linkCodes.get(code) || null;
  }

  async updateLinkCode(linkCode: LinkCode): Promise<LinkCode> {
    this.linkCodes.set(linkCode.code, { ...linkCode });
    return linkCode;
  }
}

/**
 * سرویس مدیریت هویت و پیوند حساب‌ها
 */
export class IdentityService {
  constructor(private repo: IdentityRepository = new InMemoryIdentityRepository()) {}

  /**
   * ورود با پیام‌رسان: دریافت حساب موجود یا ایجاد حساب جدید بدون نیاز به شماره تماس (DEC-0043)
   */
  async getOrCreateAccount(
    channelType: ChannelType,
    channelUserId: string
  ): Promise<{ person: Person; channelAccount: ChannelAccount; isNew: boolean }> {
    const existingChannel = await this.repo.findChannelAccount(channelType, channelUserId);

    if (existingChannel) {
      const person = await this.repo.findPersonById(existingChannel.personId);
      if (!person) {
        throw new Error(`DATA_CORRUPTION: حساب شخص برای کانال ${channelType}:${channelUserId} یافت نشد.`);
      }
      return { person, channelAccount: existingChannel, isNew: false };
    }

    // ساخت شخص جدید بدون شماره تلفن (DEC-0043)
    const now = new Date();
    const newPerson: Person = {
      id: `person-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      phoneNumber: null,
      createdAt: now,
      updatedAt: now
    };
    await this.repo.createPerson(newPerson);

    const newChannel: ChannelAccount = {
      id: `chan-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      personId: newPerson.id,
      channelType,
      channelUserId,
      createdAt: now
    };
    await this.repo.createChannelAccount(newChannel);

    return { person: newPerson, channelAccount: newChannel, isNew: true };
  }

  /**
   * صدور کد پیوند ۲۴ ساعته برای اتصال پیام‌رسان دوم (DEC-0040)
   */
  async generateLinkingCode(personId: string, now: Date = new Date()): Promise<LinkCode> {
    const person = await this.repo.findPersonById(personId);
    if (!person) {
      throw new Error('PERSON_NOT_FOUND: شخص مورد نظر یافت نشد.');
    }

    // تولید کد رندوم ۶ رقمی امن
    const randomCode = Math.floor(100000 + Math.random() * 900000).toString();
    const linkCode = generateLinkCode(personId, randomCode, now);
    await this.repo.saveLinkCode(linkCode);

    return linkCode;
  }

  /**
   * مصرف کد پیوند در پیام‌رسان دوم و اتصال به شخص مبدأ (DEC-0040)
   */
  async redeemLinkingCode(
    channelType: ChannelType,
    channelUserId: string,
    code: string,
    currentTime: Date = new Date()
  ): Promise<{ success: boolean; person?: Person; error?: string }> {
    const linkCode = await this.repo.findLinkCode(code);

    if (!linkCode) {
      return { success: false, error: 'INVALID_CODE: کد واردشده معتبر نیست.' };
    }

    const validation = validateLinkCode(linkCode, currentTime);
    if (!validation.isValid) {
      return { success: false, error: validation.reason };
    }

    const targetPerson = await this.repo.findPersonById(linkCode.personId);
    if (!targetPerson) {
      return { success: false, error: 'PERSON_NOT_FOUND' };
    }

    // بررسی کانال در پیام‌رسان دوم
    let channelAccount = await this.repo.findChannelAccount(channelType, channelUserId);

    if (channelAccount) {
      // اگر کانال از قبل به همان شخص متصل باشد
      if (channelAccount.personId === targetPerson.id) {
        return { success: false, error: 'ALREADY_LINKED: این حساب از قبل به همین شخص متصل است.' };
      }

      // اگر کانال قبلاً به شخص دیگری متصل باشد که داده مستقل دارد (تعارض)
      const existingLinkedAccounts = await this.repo.getChannelAccountsByPersonId(channelAccount.personId);
      if (existingLinkedAccounts.length > 1) {
        return { success: false, error: 'ACCOUNT_CONFLICT: این حساب قبلاً با حساب دیگری پیوند خورده است.' };
      }

      // اتصال کانال به حساب اصلی
      channelAccount.personId = targetPerson.id;
      await this.repo.updateChannelAccount(channelAccount);
    } else {
      // ثبت کانال جدید برای همین شخص
      channelAccount = {
        id: `chan-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        personId: targetPerson.id,
        channelType,
        channelUserId,
        createdAt: currentTime
      };
      await this.repo.createChannelAccount(channelAccount);
    }

    // علامت‌گذاری کد به عنوان مصرف‌شده (یک‌بارمصرف بودن DEC-0040)
    linkCode.usedAt = currentTime;
    await this.repo.updateLinkCode(linkCode);

    return { success: true, person: targetPerson };
  }

  /**
   * دریافت فهرست کانال‌های متصل به یک شخص
   */
  async getLinkedChannels(personId: string): Promise<ChannelAccount[]> {
    return this.repo.getChannelAccountsByPersonId(personId);
  }

  /**
   * دریافت اطلاعات شخص با شناسه
   */
  async getPersonById(personId: string): Promise<Person | null> {
    return this.repo.findPersonById(personId);
  }

  /**
   * ثبت شماره تلفن شخص هنگام درخواست رزرو (DEC-0043)
   */
  async recordPhoneNumberAtBooking(personId: string, phoneNumber: string): Promise<Person> {
    const person = await this.repo.findPersonById(personId);
    if (!person) {
      throw new Error('PERSON_NOT_FOUND');
    }
    person.phoneNumber = phoneNumber;
    person.updatedAt = new Date();
    return this.repo.updatePerson(person);
  }
}
