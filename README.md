# سامانه رزرو اسکان زائر

این مخزن فعلاً شامل تحلیل محصول و مسترهای اجرایی است. کد بات‌ها و پایگاه داده هنوز نوشته نشده‌اند. نقطه شروع مطالعه [وضعیت پروژه](docs/ai/PROJECT_STATE.md)، سپس [فهرست کارهای باز](docs/ai/BACKLOG.md)، [نمایه اسناد](docs/ai/INDEX.md) و [نقشه اصلی](docs/ai/ROOT_MASTER.md) است.

کارفرما آغاز مرحله‌ای طراحی فنی و پیاده‌سازی محلی را طبق DEC-0044 مجاز کرده است. [ممیزی آمادگی](docs/ai/IMPLEMENTATION_READINESS_AUDIT.md)، [مستر شروع فاز اول](docs/ai/masters/MASTER_12_PHASE_ONE_IMPLEMENTATION_START.md)، [راهنمای نقش‌های بازبین](docs/ai/agents/AGENT_PLAYBOOK.md) و فایل `پرامپت شروع کدنویسی پروژه.txt` مسیر تحویل به عامل کدنویس‌اند. استقرار VPS هنوز مجوز جدا می‌خواهد.

## gstack در این پروژه

برای متن‌های آماده و مثال‌های ساده، [راهنمای استفاده از gstack](راهنمای%20استفاده%20از%20gstack.txt) را باز کنید.

نسخه gstack به‌صورت زیرمخزن Git در `.claude/skills/gstack` ثابت شده است. برای دریافت آن در یک کپی تازه از پروژه، در ریشه پروژه این دستورها را در PowerShell اجرا کنید:

    git submodule update --init --recursive
    Set-Location .claude/skills/gstack
    .\setup.ps1 --host codex
    .\setup.ps1 --status

برای نصب در ویندوز، Git for Windows، Bun و Node.js لازم‌اند. نصب پروژه‌ای مهارت‌های `gstack-*` را در `.agents/skills/` تولید می‌کند؛ این فایل‌ها خروجی محلی‌اند و در Git ثبت نمی‌شوند. پس از نصب، یک گفت‌وگوی تازه در Codex باز کنید تا فهرست مهارت‌ها تازه شود.

در گفت‌وگوی Codex می‌توانید مستقیم بگویید:

- «از `gstack-office-hours` برای بررسی ایده و اسناد اسکان زائر استفاده کن؛ فقط تحلیل، بدون کد.»
- «با `gstack-plan-eng-review` سند [مستر رزرو](docs/ai/masters/MASTER_05_TRAVELER_SEARCH_AND_BOOKING.md) را بازبینی کن.»
- «با `gstack-review` تغییرات شاخه را بازبینی کن.»

در مرحله فعلی، خروجی gstack باید در ساختار `docs/ai/` و پس از تطبیق با [دفتر تصمیم‌ها](docs/ai/DECISIONS.md) ثبت شود. بازبینی و پیاده‌سازی محلیِ مرحله‌ای مجاز است، اما دستورهای انتشار و استقرار gstack هنوز مجوز جداگانه می‌خواهند. راهنمای کامل ابزار در [مخزن gstack](https://github.com/garrytan/gstack) است.
