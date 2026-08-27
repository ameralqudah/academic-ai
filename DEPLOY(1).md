# دليل النشر — من صفر إلى رابط يعمل

> الوقت المتوقّع: **٢٠–٣٠ دقيقة**. كل الحسابات المطلوبة لها طبقة مجانية عدا مفتاح الذكاء
> الاصطناعي (يحتاج رصيدًا صغيرًا، ٥ دولارات تكفي لمئات الطلبات).

الترتيب مهم: نجهّز الخدمات الثلاث أولًا، ثم ننشر، ثم نتحقق.

---

## نظرة سريعة على ما ستفعله

| # | الخطوة | الخدمة | الناتج |
|---|--------|--------|--------|
| 1 | قاعدة البيانات | [neon.com](https://neon.com) | `DATABASE_URL` |
| 2 | مفتاح الذكاء الاصطناعي | [console.anthropic.com](https://console.anthropic.com) | `ANTHROPIC_API_KEY` |
| 3 | البريد | [resend.com](https://resend.com) | `RESEND_API_KEY` |
| 4 | سرّ الجلسات | جهازك | `AUTH_SECRET` |
| 5 | النشر | [vercel.com](https://vercel.com) | رابط التطبيق |
| 6 | التحقق | `/api/health` | `"status": "ok"` |

---

## 1) قاعدة البيانات — Neon

1. افتح [neon.com](https://neon.com) → **Sign up** (يمكن بحساب GitHub).
2. **Create project**:
   - Name: `academic-ai`
   - Postgres version: اترك الافتراضي
   - Region: **Europe (Frankfurt)** — الأقرب للمنطقة العربية وتطابق منطقة Vercel في `vercel.json`.
3. بعد الإنشاء تظهر لك **Connection string**. تأكد أن المُبدّل على **Pooled connection**
   (الرابط يحتوي `-pooler`)، واضغط **Copy**.
4. احفظه — هذا هو `DATABASE_URL`. شكله:

```
postgresql://neondb_owner:XXXX@ep-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

> **مهم:** استخدم رابط **Pooled**. الرابط المباشر (بدون `-pooler`) ينفد اتصالاته بسرعة
> على منصة Serverless.

---

## 2) مفتاح الذكاء الاصطناعي — Anthropic

1. افتح [console.anthropic.com](https://console.anthropic.com) → أنشئ حسابًا.
2. **Billing** → **Add credit** → اشحن مبلغًا صغيرًا (٥ دولارات كافية للتجربة).
   بدون رصيد سيردّ المزوّد بخطأ ولن تعمل وظائف التوليد.
3. **API Keys** → **Create Key** → سمِّه `academic-ai-production` → **Copy**.
4. احفظه — هذا هو `ANTHROPIC_API_KEY`. يبدأ بـ `sk-ant-`.

> المفتاح يُعرض مرة واحدة فقط. إن فقدته أنشئ غيره واحذف القديم.
>
> **تريد OpenAI أو Google بدلًا منه؟** ضع `AI_PROVIDER=openai` مع `OPENAI_API_KEY`،
> أو `AI_PROVIDER=google` مع `GOOGLE_AI_API_KEY`. لا يحتاج الكود أي تعديل.

---

## 3) البريد الإلكتروني — Resend

1. افتح [resend.com](https://resend.com) → **Sign up**.
2. **API Keys** → **Create API Key**:
   - Name: `academic-ai`
   - Permission: **Sending access**
   - **Copy** المفتاح (يبدأ بـ `re_`) — هذا هو `RESEND_API_KEY`.
3. **المرسِل:**
   - **للبدء فورًا بلا نطاق:** اترك `EMAIL_FROM="Academic AI <onboarding@resend.dev>"`.
     ⚠️ قيد Resend: بنطاق الاختبار هذا **لن تصل الرسائل إلا إلى بريدك المسجَّل في Resend**.
     كافٍ لتجربتك أنت، غير كافٍ لمستخدمين حقيقيين.
   - **للمستخدمين الحقيقيين:** **Domains** → **Add Domain** → أدخل نطاقك →
     أضف سجلات DNS التي يعرضها (MX و TXT و DKIM) عند مزوّد نطاقك → انتظر التحقق
     (دقائق إلى ساعات) → ثم اضبط:
     `EMAIL_FROM="Academic AI <no-reply@your-domain.com>"`

---

## 4) سرّ الجلسات — AUTH_SECRET

على اللابتوب (Terminal على macOS/Linux، أو Git Bash على Windows):

```bash
openssl rand -base64 32
```

انسخ الناتج — هذا هو `AUTH_SECRET`. أو استخدم [generate-secret.vercel.app/32](https://generate-secret.vercel.app/32).

---

## 5) النشر على Vercel

### أ) ارفع الكود إلى GitHub

إن كنتُ قد رفعتُه لك، تجاوز هذه الفقرة. وإلا، من مجلد المشروع:

```bash
git init
git add .
git commit -m "Academic AI Research Assistant"
git branch -M main
git remote add origin https://github.com/<username>/academic-ai.git
git push -u origin main
```

### ب) استورد المشروع في Vercel

1. [vercel.com](https://vercel.com) → **Sign up with GitHub**.
2. **Add New…** → **Project** → اختر المستودع → **Import**.
3. **لا تضغط Deploy بعد.** افتح **Environment Variables** وأضف هذه الستة:

| المفتاح | القيمة |
|---------|--------|
| `DATABASE_URL` | رابط Neon المجمَّع من الخطوة 1 |
| `AUTH_SECRET` | ناتج الأمر من الخطوة 4 |
| `ANTHROPIC_API_KEY` | مفتاح الخطوة 2 |
| `AI_PROVIDER` | `anthropic` |
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | مفتاح الخطوة 3 |
| `EMAIL_FROM` | `Academic AI <onboarding@resend.dev>` أو بريد نطاقك |
| `SEED_ADMIN_EMAIL` | بريدك — لإنشاء حساب المدير |
| `SEED_ADMIN_PASSWORD` | كلمة مرور قوية تختارها |

4. اضغط **Deploy**. سيستغرق البناء ٢–٤ دقائق.

**ماذا يحدث أثناء البناء؟** أمر البناء هو `npm run vercel-build`، وهو ينفّذ بالترتيب:
هجرة قاعدة البيانات (إنشاء الجداول الثمانية عشر) → بذر خطتَي FREE و PRO وحساب المدير → بناء Next.js.
فلا حاجة لأي أمر يدوي على قاعدة البيانات.

### ج) أكمل المتغيّرين المعتمدين على الرابط

بعد ظهور رابطك (مثل `https://academic-ai-xxxx.vercel.app`):

1. **Settings** → **Environment Variables** → أضف:
   - `AUTH_URL` = رابط تطبيقك كاملًا
   - `APP_URL` = نفس الرابط
2. **Deployments** → آخر نشر → زر **⋯** → **Redeploy**.

> بدون `AUTH_URL` قد يفشل تسجيل الدخول خلف بعض الوكلاء، وروابط إعادة تعيين كلمة المرور
> ستشير إلى `localhost`.

---

## 6) التحقق من أن كل شيء يعمل

افتح في المتصفّح:

```
https://<رابطك>/api/health
```

المطلوب `"status": "ok"` وهذه القيم:

```jsonc
{
  "status": "ok",
  "checks": {
    "database": { "connected": true, "tables": 18, "plansSeeded": 2, "defaultPlan": true },
    "ai":       { "provider": "anthropic", "configured": true },
    "email":    { "provider": "resend", "deliversRealEmail": true },
    "auth":     { "secretConfigured": true }
  }
}
```

| إن رأيت | السبب | الحل |
|---------|-------|------|
| `database.connected: false` | رابط خاطئ أو غير مجمَّع | انسخ رابط **Pooled** من Neon مجددًا |
| `tables: 0` أو `plansSeeded: 0` | الهجرة لم تُنفَّذ | راجع سجل البناء في Vercel → Build Logs |
| `ai.configured: false` | المفتاح مفقود | تأكد من `ANTHROPIC_API_KEY` ثم أعد النشر |
| `email.provider: "console"` | `EMAIL_PROVIDER` ليس `resend` أو المفتاح ناقص | اضبط `EMAIL_PROVIDER=resend` و`RESEND_API_KEY` و`EMAIL_FROM` |

ثم جرّب يدويًا بهذا الترتيب:

1. افتح الرابط الرئيسي → يجب أن تظهر الصفحة بالعربية من اليمين لليسار.
2. **إنشاء حساب** ببريد حقيقي → يجب أن تصل إلى لوحة التحكم.
3. **مشروع بحثي جديد** → املأ الحقول → **ولّد عناوين البحث**.
   ظهور عشرة عناوين = الذكاء الاصطناعي يعمل فعليًا.
4. اختر عنوانًا → **معالج البحث** → الخطوة ٢ → **ولّد بالذكاء الاصطناعي**.
5. سجّل الخروج → **نسيت كلمة المرور؟** → أدخل بريدك → يجب أن تصل الرسالة.
6. ادخل بحساب المدير (`SEED_ADMIN_EMAIL`) → يظهر رابط **لوحة الإدارة** في القائمة.

بعد نجاح الخطوة ٦: **احذف `SEED_ADMIN_EMAIL` و`SEED_ADMIN_PASSWORD` من Vercel** وأعد النشر.
الحساب أُنشئ بالفعل ولا حاجة لبقاء كلمة المرور في المتغيّرات.

---

## 7) اختياري — بعد أن يعمل كل شيء

### نطاقك الخاص
Vercel → **Settings** → **Domains** → **Add** → اتبع تعليمات DNS.
ثم حدّث `AUTH_URL` و`APP_URL` إلى النطاق الجديد وأعد النشر.

### تسجيل الدخول بـ Google
[console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services** →
**Credentials** → **Create OAuth client ID** → Web application →
Authorized redirect URI: `https://<رابطك>/api/auth/callback/google`
ثم أضف `AUTH_GOOGLE_ID` و`AUTH_GOOGLE_SECRET`. الزر يظهر تلقائيًا.

### الدفع الحقيقي بـ PayPal  (الموصى به للأردن — Stripe لا يقبل التجّار الأردنيين)
1. أنشئ حساب **PayPal Business** من [paypal.com/jo/business](https://www.paypal.com/jo/business)
   واربط حسابك البنكي الأردني.
2. أنشئ تطبيقًا من [developer.paypal.com](https://developer.paypal.com/dashboard/applications/live)
   وانسخ **Client ID** و **Secret**.
3. أضف Webhook في نفس الصفحة:
   - URL: `https://<رابطك>/api/billing/webhook`
   - الأحداث: `BILLING.SUBSCRIPTION.ACTIVATED` · `UPDATED` · `CANCELLED` · `SUSPENDED` ·
     `EXPIRED` · `BILLING.SUBSCRIPTION.PAYMENT.FAILED` · `PAYMENT.SALE.COMPLETED` ·
     `PAYMENT.SALE.REFUNDED`
   ثم انسخ **Webhook ID**.
4. أضف متغيّرات البيئة: `BILLING_PROVIDER=paypal` · `PAYPAL_ENVIRONMENT=live` ·
   `PAYPAL_CLIENT_ID` · `PAYPAL_CLIENT_SECRET` · `PAYPAL_WEBHOOK_ID`.
5. خطة Pro تُنشأ تلقائيًا في PayPal من السعر المخزّن في قاعدة البيانات — لا حاجة لإنشائها يدويًا.

> للتجربة أولًا: كرّر الخطوتين 2 و3 في **Sandbox** واضبط `PAYPAL_ENVIRONMENT=sandbox`.

### الدفع الحقيقي بـ Stripe  (لتجّار الدول المدعومة فقط)
1. أنشئ منتجًا وسعرًا شهريًا ($15) في [dashboard.stripe.com](https://dashboard.stripe.com).
2. أضف: `BILLING_PROVIDER=stripe`، `STRIPE_SECRET_KEY`، `STRIPE_PRO_PRICE_ID`.
3. **Developers** → **Webhooks** → **Add endpoint**:
   - URL: `https://<رابطك>/api/billing/webhook`
   - الأحداث: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
4. انسخ **Signing secret** إلى `STRIPE_WEBHOOK_SECRET` وأعد النشر.

### تحديد المعدّل المشترك
عند تشغيل أكثر من نسخة: أنشئ قاعدة على [upstash.com](https://upstash.com) وأضف
`RATE_LIMIT_STORE=redis` مع `UPSTASH_REDIS_REST_URL` و`UPSTASH_REDIS_REST_TOKEN`.

### الصفحات القانونية
`/privacy` و`/terms` منشورتان وتصفان سلوك النظام الفعلي، لكن فيهما حقول بين أقواس
(`[اسم الجهة المشغِّلة]`, `[الدولة/الولاية القضائية]`, `[support@your-domain.com]`).
عدّلها في `src/content/legal.ts` واعرضها على مستشار قانوني قبل الإطلاق التجاري.

---

## 8) الصيانة

| المهمة | كيف |
|--------|-----|
| نشر تحديث | ادفع إلى `main` — ينشر Vercel تلقائيًا ويشغّل الهجرات |
| تعديل حدود الخطط أو الأسعار | لوحة الإدارة → **الخطط** (بلا نشر جديد) |
| تبديل مزوّد الذكاء الاصطناعي | لوحة الإدارة → **استهلاك AI**، أو غيّر `AI_PROVIDER` |
| متابعة التكلفة | لوحة الإدارة → **نظرة عامة** → التكلفة التقديرية |
| تغيير مخطط قاعدة البيانات | عدّل `src/server/db/schema.ts` ثم `npm run db:generate` ثم ادفع |
| نسخة احتياطية | Neon → **Backups** (نقطة زمنية على الخطة المجانية) |
| مراجعة السجلات | Vercel → **Logs** (كل سطر JSON منظّم) |
| تدوير سرّ الجلسات | غيّر `AUTH_SECRET` — سيُسجَّل خروج الجميع |

### الأخطاء الشائعة بعد النشر

- **`Invalid environment configuration`** في سجل البناء → متغيّر مطلوب مفقود؛ الرسالة تسمّيه.
- **`No default subscription plan is configured`** → البذر لم يعمل؛ شغّل محليًا:
  `DATABASE_URL="<رابط Neon>" npm run db:seed`
- **رسائل البريد لا تصل** → إن كنت على `onboarding@resend.dev` فهي تصل فقط إلى بريدك المسجَّل
  في Resend؛ وثّق نطاقك للإرسال إلى أي أحد.
- **`PLAN_LIMIT` فورًا** → الخطة المجانية مشروع واحد و٢٠ طلبًا شهريًا. عدّلها من لوحة الإدارة.
