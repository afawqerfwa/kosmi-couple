# Kosmi Couple for Cloudflare

اتاق دونفره‌ی تماشای مشترک با ظاهر بنفش، چت، سینک کامل کنترل‌ها و پخش زنده‌ی فایل محلی از مرورگر یک نفر به نفر دوم.

## امکانات

- اتاق خصوصی با ظرفیت دقیقاً دو نفر و لینک قابل کپی
- همگام‌سازی پخش، توقف، جلو/عقب بردن، سرعت، صدا و mute
- دکمه‌های مشترک پخش/توقف، ۱۰ ثانیه عقب، ۱۰ ثانیه جلو و نوار زمان
- پخش زنده‌ی فایل محلی با WebRTC؛ فایل کامل روی سرور یا حافظه‌ی نفر دوم ذخیره نمی‌شود
- چت داخل اتاق و نمایش وضعیت اتصال
- Durable Object جداگانه برای هر اتاق
- استاتیک سایت با Cloudflare Assets
- پشتیبانی از STUN و تنظیم TURN برای شبکه‌های سخت‌گیر

## انتشار روی Cloudflare Workers

این پروژه برای **Cloudflare Workers + Durable Objects** آماده است، نه Railway و نه Node/Express.

1. در Cloudflare یک API Token یا ورود Wrangler را آماده کنید.
2. داخل پوشه‌ی پروژه اجرا کنید:

```bash
npm install
npx wrangler login
npx wrangler deploy
```

3. Wrangler یک دامنه‌ی `workers.dev` می‌دهد. همان لینک را برای نفر دوم بفرستید.

فایل `wrangler.toml`، سرویس استاتیک، Worker و Durable Object اتاق‌ها را تنظیم می‌کند. برای GitHub Actions یا Deploy خودکار Cloudflare، دستور Deploy همین است:

```bash
npx wrangler deploy
```

## اجرای محلی Cloudflare

```bash
cp .dev.vars.example .dev.vars
npm install
npx wrangler dev
```

سپس آدرس محلی‌ای که Wrangler نشان می‌دهد را باز کنید. برای تست واقعی، دو پنجره یا دو دستگاه را با یک کد اتاق وارد کنید.

## تنظیم TURN

اعتبارنامه‌های تصویر ارسالی عمداً داخل GitHub یا ZIP قرار نگرفته‌اند. آن‌ها را در Cloudflare Dashboard از مسیر **Workers & Pages → پروژه → Settings → Variables and Secrets** به‌صورت Secret اضافه کنید:

```text
TURN_URLS=turn:HOST:3478,turns:HOST:5349
TURN_USERNAME=نام کاربری TURN
TURN_PASSWORD=رمز TURN
```

یا آرایه‌ی آماده‌ی ICE را در یک Secret با نام `TURN_ICE_SERVERS_JSON` قرار دهید:

```text
[{"urls":["turn:HOST:3478"],"username":"...","credential":"..."}]
```

آدرس واقعی `HOST` را از **Show ICE Servers Array** در سرویس TURN بردارید. رمزها را داخل GitHub یا فایل‌های پروژه commit نکنید.

## نکات پخش

- فایل محلی به‌صورت زنده از مرورگر نفر اول به نفر دوم می‌رود؛ هر دو نفر باید صفحه را باز نگه دارند.
- حجم فایل به‌تنهایی معیار مصرف نیست؛ کیفیت و bitrate فیلم و مدت تماشا تعیین‌کننده‌اند.
- اگر پخش سمت دوستتان خودکار شروع نشد، روی دکمه‌ی «▶ پخش» بزنید.
- لینک فیلم باید مستقیم و قابل پخش در مرورگر باشد؛ بعضی سایت‌ها CORS یا محافظت ضدجاسازی دارند.
- برای شبکه‌های سخت‌گیر، TURN را حتماً تنظیم کنید. STUN به‌تنهایی همیشه کافی نیست.
- اطلاعات اتاق و چت در Durable Object ذخیره‌ی موقت می‌شود؛ فایل ویدئو روی Worker ذخیره نمی‌شود.

## مجوز

MIT
