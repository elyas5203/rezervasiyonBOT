/**
 * سرویس مدیریت، احراز هویت وب‌ویو مرورگر و کنترل دسترسی ادمین
 * منبع حقیقت: DEC-0004, DEC-0012, DEC-0028, DEC-0041 و مسترهای ۰۸ و ۲۲
 */

import { MokabPlace, ReservationRequest } from '../core/types';
import { InventoryService } from '../core/inventory/inventory-service';
import { ReservationService } from '../core/reservation/reservation-service';

/** نقش‌های مصوب مدیریت سامانه (DEC-0004) */
export type AdminRole = 'SUPER_ADMIN' | 'APPOINTED_ADMIN';

/** موجودیت کاربر ادمین */
export interface AdminUser {
  id: string;
  displayName: string;
  role: AdminRole;
  telegramUserId?: string;
  baleUserId?: string;
  isActive: boolean;
  createdAt: Date;
  appointedBy?: string | null;
}

/** توکن یک‌بارمصرف ورود به وب‌ویو مرورگر (Magic Login Token) */
export interface AdminLoginToken {
  token: string;
  adminId: string;
  expiresAt: Date;
  usedAt?: Date | null;
}

/** نشست فعال مرورگر ادمین (DEC-0028) */
export interface AdminSession {
  sessionId: string;
  adminId: string;
  role: AdminRole;
  createdAt: Date;
  expiresAt: Date;
  isValid: boolean;
}

/** لاگ ممیزی تصمیم‌های مدیریتی (Audit Trail) */
export interface AdminAuditLog {
  id: string;
  adminId: string;
  action: 'APPROVE_HOST' | 'REJECT_HOST' | 'REQUEST_INFO' | 'APPOINT_ADMIN' | 'EMERGENCY_INSPECT';
  targetId: string;
  reason: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

/** گزارش تعطیلی اضطراری موکب */
export interface EmergencyClosureReport {
  placeId: string;
  placeTitle: string;
  affectedReservationsCount: number;
  affectedReservations: {
    reservationId: string;
    trackingCode: string;
    contactPhone: string;
    checkInDate: string;
    checkOutDate: string;
    status: string;
  }[];
  inspectedAt: Date;
}

/**
 * سرویس احراز هویت و مدیریت نشست‌های وب‌ویو مرورگر (DEC-0028)
 */
export class AdminAuthService {
  private admins: Map<string, AdminUser> = new Map();
  private loginTokens: Map<string, AdminLoginToken> = new Map();
  private sessions: Map<string, AdminSession> = new Map();

  constructor() {
    // ایجاد پیش‌فرض مدیر اصلی سیستم (Super Admin)
    const superAdmin: AdminUser = {
      id: 'admin-super-001',
      displayName: 'مدیر اصلی سامانه',
      role: 'SUPER_ADMIN',
      isActive: true,
      createdAt: new Date(),
    };
    this.admins.set(superAdmin.id, superAdmin);
  }

  /**
   * ثبت یا افزودن ادمین جدید در سامانه
   */
  async registerAdmin(admin: AdminUser): Promise<AdminUser> {
    this.admins.set(admin.id, { ...admin });
    return admin;
  }

  /**
   * یافتن ادمین بر اساس شناسه
   */
  async findAdminById(adminId: string): Promise<AdminUser | null> {
    return this.admins.get(adminId) || null;
  }

  /**
   * صدور توکن یک‌بارمصرف ورود امن به وب‌ویو مرورگر (DEC-0028)
   */
  async generateLoginToken(adminId: string, ttlSeconds: number = 300): Promise<string> {
    const admin = this.admins.get(adminId);
    if (!admin || !admin.isActive) {
      throw new Error('ADMIN_NOT_FOUND_OR_INACTIVE: مدیر فعال با این شناسه یافت نشد.');
    }

    const token = `magic-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    this.loginTokens.set(token, {
      token,
      adminId,
      expiresAt,
    });

    return token;
  }

  /**
   * مبادله توکن یک‌بارمصرف با نشست مرورگر (Replay Attack Prevention)
   */
  async exchangeTokenForSession(token: string, sessionTtlHours: number = 8): Promise<AdminSession> {
    const record = this.loginTokens.get(token);
    if (!record) {
      throw new Error('INVALID_TOKEN: توکن ورود نامعتبر است.');
    }

    if (record.usedAt) {
      throw new Error('TOKEN_ALREADY_USED: این توکن قبلاً استفاده شده و یک‌بارمصرف است.');
    }

    if (new Date() > record.expiresAt) {
      throw new Error('TOKEN_EXPIRED: مهلت استفاده از این توکن به پایان رسیده است.');
    }

    const admin = this.admins.get(record.adminId);
    if (!admin || !admin.isActive) {
      throw new Error('ADMIN_INACTIVE: حساب کاربری مدیر غیرفعال است.');
    }

    // مصرف توکن
    record.usedAt = new Date();
    this.loginTokens.set(token, record);

    // صدور نشست
    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).substring(2, 12)}`;
    const session: AdminSession = {
      sessionId,
      adminId: admin.id,
      role: admin.role,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + sessionTtlHours * 3600 * 1000),
      isValid: true,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * اعتبارسنجی نشست مرورگر
   */
  async validateSession(sessionId: string): Promise<AdminUser> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isValid) {
      throw new Error('UNAUTHORIZED: نشست نامعتبر است یا منقضی شده است.');
    }

    if (new Date() > session.expiresAt) {
      session.isValid = false;
      throw new Error('SESSION_EXPIRED: نشست منقضی شده است.');
    }

    const admin = this.admins.get(session.adminId);
    if (!admin || !admin.isActive) {
      throw new Error('ADMIN_INACTIVE: کاربر غیرفعال است.');
    }

    return admin;
  }

  /**
   * ابطال نشست (خروج از پنل)
   */
  async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isValid = false;
    }
  }
}

/**
 * سرویس عملیات و تصمیم‌گیری مدیریت سامانه
 */
export class AdminManagementService {
  private authService: AdminAuthService;
  private inventoryService: InventoryService;
  private reservationService?: ReservationService;
  private auditLogs: AdminAuditLog[] = [];

  constructor(
    authService: AdminAuthService,
    inventoryService: InventoryService,
    reservationService?: ReservationService
  ) {
    this.authService = authService;
    this.inventoryService = inventoryService;
    this.reservationService = reservationService;
  }

  /**
   * انتصاب ادمین جدید منحصراً توسط مدیر اصلی (DEC-0004)
   */
  async appointAdmin(
    sessionId: string,
    targetData: {
      displayName: string;
      telegramUserId?: string;
      baleUserId?: string;
    }
  ): Promise<AdminUser> {
    const currentAdmin = await this.authService.validateSession(sessionId);

    // قاعده صریح: تنها SUPER_ADMIN مجاز به انتصاب است
    if (currentAdmin.role !== 'SUPER_ADMIN') {
      throw new Error('FORBIDDEN_ONLY_SUPER_ADMIN_CAN_APPOINT: تنها مدیر اصلی سامانه حق انتصاب ادمین را دارد.');
    }

    const newAdmin: AdminUser = {
      id: `admin-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      displayName: targetData.displayName,
      role: 'APPOINTED_ADMIN',
      telegramUserId: targetData.telegramUserId,
      baleUserId: targetData.baleUserId,
      isActive: true,
      createdAt: new Date(),
      appointedBy: currentAdmin.id,
    };

    await this.authService.registerAdmin(newAdmin);

    // ثبت ممیزی
    this.auditLogs.push({
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      adminId: currentAdmin.id,
      action: 'APPOINT_ADMIN',
      targetId: newAdmin.id,
      reason: `انتصاب ادمین منصوب جدید: ${newAdmin.displayName}`,
      timestamp: new Date(),
    });

    return newAdmin;
  }

  /**
   * دریافت فهرست موکب‌های منتظر بررسی برای نمایش در وب‌ویو ادمین
   */
  async getPendingHosts(sessionId: string): Promise<MokabPlace[]> {
    await this.authService.validateSession(sessionId);
    // استفاده از ریپازیتوری موکب‌ها برای استخراج رکوردهای PENDING
    const repo = (this.inventoryService as any).repo;
    if (repo && repo.places) {
      const places: MokabPlace[] = Array.from(repo.places.values());
      return places.filter(p => p.status === 'PENDING');
    }
    return [];
  }

  /**
   * بررسی و ثبت تصمیم پرونده موکب همراه با دلیل مستند (DEC-0004, DEC-0019)
   */
  async reviewHost(
    sessionId: string,
    placeId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_INFO',
    reason: string
  ): Promise<MokabPlace> {
    const admin = await this.authService.validateSession(sessionId);

    if (!reason || reason.trim().length === 0) {
      throw new Error('REASON_REQUIRED: ثبت دلیل مستند برای تصمیم مدیر الزامی است.');
    }

    const targetDecision = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const updated = await this.inventoryService.reviewMokabPlace(
      placeId,
      admin.id,
      targetDecision,
      reason
    );

    // ثبت لاگ ممیزی تصمیم
    const actionType = decision === 'APPROVE' ? 'APPROVE_HOST' : decision === 'REJECT' ? 'REJECT_HOST' : 'REQUEST_INFO';
    this.auditLogs.push({
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      adminId: admin.id,
      action: actionType,
      targetId: placeId,
      reason,
      timestamp: new Date(),
      metadata: { newStatus: updated.status },
    });

    return updated;
  }

  /**
   * بررسی فیش پرداخت کارت‌به‌کارت
   * ⚠️ مرز صریح بیزینس (DEC-0012, MASTER-08 ADM-03):
   * مدیر سامانه اکیداً حق تأیید یا رد فیش واریز مسافر به‌جای موکب‌دار را ندارد!
   */
  async verifyPaymentReceipt(sessionId: string, reservationId: string, decision: boolean): Promise<never> {
    await this.authService.validateSession(sessionId);
    throw new Error('ADMIN_CANNOT_VERIFY_PAYMENT_RECEIPT: طبق DEC-0012 و MASTER-08 ADM-03، ادمین حق بررسی و تأیید فیش پرداخت کارت‌به‌کارت را ندارد و این عمل منحصراً در اختیار موکب‌دار همان محل است.');
  }

  /**
   * رسیدگی به تعطیلی اضطراری موکب (DEC-0004, MASTER-08 ADM-02)
   * رزروهای موجود بدون حذف فیزیکی استخراج و گزارش می‌شوند.
   */
  async inspectEmergencyClosure(sessionId: string, placeId: string): Promise<EmergencyClosureReport> {
    const admin = await this.authService.validateSession(sessionId);

    const place = await this.inventoryService.getPlaceById(placeId);
    if (!place) {
      throw new Error('PLACE_NOT_FOUND: موکب مورد نظر یافت نشد.');
    }

    // تغییر وضعیت موکب به تعلیق جهت جلوگیری از رزرو جدید
    place.status = 'SUSPENDED';
    const repo = (this.inventoryService as any).repo;
    if (repo && repo.updatePlace) {
      await repo.updatePlace(place);
    }

    // استخراج رزروهای فعال این موکب
    const affectedReservations: EmergencyClosureReport['affectedReservations'] = [];
    if (this.reservationService) {
      const allRes = await this.reservationService.getReservationsByPlaceId(placeId);
      for (const res of allRes) {
        if (['CONFIRMED', 'PENDING_HOST_APPROVAL', 'PENDING_PAYMENT_RECEIPT', 'PENDING_RECEIPT_VERIFICATION'].includes(res.status)) {
          affectedReservations.push({
            reservationId: res.id,
            trackingCode: res.trackingCode,
            contactPhone: res.contactPhone,
            checkInDate: res.checkInDate,
            checkOutDate: res.checkOutDate,
            status: res.status,
          });
        }
      }
    }

    // ثبت لاگ ممیزی
    this.auditLogs.push({
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      adminId: admin.id,
      action: 'EMERGENCY_INSPECT',
      targetId: placeId,
      reason: `بررسی تعطیلی اضطراری موکب ${place.title}. تعداد رزروهای متأثر: ${affectedReservations.length}`,
      timestamp: new Date(),
    });

    return {
      placeId,
      placeTitle: place.title,
      affectedReservationsCount: affectedReservations.length,
      affectedReservations,
      inspectedAt: new Date(),
    };
  }

  /**
   * دریافت لاگ‌های ممیزی
   */
  async getAuditLogs(sessionId: string): Promise<AdminAuditLog[]> {
    await this.authService.validateSession(sessionId);
    return [...this.auditLogs];
  }
}
