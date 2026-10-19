import { describe, it, expect } from "bun:test";
import { escapeHtml, TelegramBotWorker } from "../channels/telegram-worker";

describe("SUBAGENT_REVIEW_MASTER — آزمون‌های رابط کاربری، پیشگیری از تزریق HTML و گام‌های بازگشت", () => {
  it("UI-01: متد escapeHtml کاراکترهای ویژه را به درستی فرار می‌دهد و مانع شکست تگ‌های HTML تلگرام می‌شود", () => {
    expect(escapeHtml("موکب <امیرالمومنین>")).toBe("موکب &lt;امیرالمومنین&gt;");
    expect(escapeHtml("تست & نمونه")).toBe("تست &amp; نمونه");
    expect(escapeHtml('نام "تستی"')).toBe("نام &quot;تستی&quot;");
    expect(escapeHtml("شارع ۱ <نزدیک حرم> & عمود ۱۰")).toBe("شارع ۱ &lt;نزدیک حرم&gt; &amp; عمود ۱۰");
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(null)).toBe("");
  });

  it("UI-02: ویزارد موکب‌دار با دریافت HOST_PREV_STEP به گام قبل بازمی‌گردد و داده‌های واردشده را حفظ می‌کند", async () => {
    const worker = new TelegramBotWorker({
      token: "mock_token_host",
      role: "HOST",
    });

    const chatId = "test_host_101";

    // ۱. ثبت موکب (گام ۱: شهر)
    await (worker as any).handleHostMessage(chatId, "", "REGISTER_HOST");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("CITY");

    // ۲. انتخاب شهر کربلا -> ورود به گام ۲ (نام موکب)
    await (worker as any).handleHostMessage(chatId, "", "HOST_CITY_کربلای معلی");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("TITLE");
    expect((worker as any).hostWizards.get(chatId)?.data.city).toBe("کربلای معلی");

    // ۳. ارسال دستور بازگشت به گام قبل (HOST_PREV_STEP)
    await (worker as any).handleHostMessage(chatId, "", "HOST_PREV_STEP");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("CITY");
    expect((worker as any).hostWizards.get(chatId)?.data.city).toBe("کربلای معلی"); // داده حفظ شده است

    // ۴. دوباره انتخاب شهر نجف اشرف -> گام ۲
    await (worker as any).handleHostMessage(chatId, "", "HOST_CITY_نجف اشرف");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("TITLE");
    expect((worker as any).hostWizards.get(chatId)?.data.city).toBe("نجف اشرف");

    // ۵. ارسال نام موکب با کاراکترهای خاص -> گام ۳ (مشخصات مسئول)
    await (worker as any).handleHostMessage(chatId, "موکب احباب <الزهرا>");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("CONTACT");
    expect((worker as any).hostWizards.get(chatId)?.data.title).toBe("موکب احباب <الزهرا>");

    // ۶. ارسال دستور متنی «مرحله قبل» -> بازگشت به گام ۲
    await (worker as any).handleHostMessage(chatId, "مرحله قبل");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("TITLE");
    expect((worker as any).hostWizards.get(chatId)?.data.title).toBe("موکب احباب <الزهرا>");
  });

  it("UI-03: پشتیبانی از بازگشت در گام‌های بعدی ویزارد موکب‌دار", async () => {
    const worker = new TelegramBotWorker({
      token: "mock_token_host_2",
      role: "HOST",
    });

    const chatId = "test_host_102";

    // گام ۱: شهر
    await (worker as any).handleHostMessage(chatId, "", "REGISTER_HOST");
    await (worker as any).handleHostMessage(chatId, "", "HOST_CITY_مشهد مقدس");
    // گام ۲: نام موکب
    await (worker as any).handleHostMessage(chatId, "موکب امام رضا");
    // گام ۳: مسئول و تماس
    await (worker as any).handleHostMessage(chatId, "حاج رضا 09123456789");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("ADDRESS");

    // بازگشت با کلمه «قبلی» به گام CONTACT
    await (worker as any).handleHostMessage(chatId, "قبلی");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("CONTACT");

    // بازگشت دوباره با «مرحله قبل» به گام TITLE
    await (worker as any).handleHostMessage(chatId, "مرحله قبل");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("TITLE");

    // جلو رفتن دوباره
    await (worker as any).handleHostMessage(chatId, "موکب ثامن الحجج");
    expect((worker as any).hostWizards.get(chatId)?.step).toBe("CONTACT");
    expect((worker as any).hostWizards.get(chatId)?.data.title).toBe("موکب ثامن الحجج");
  });
});
