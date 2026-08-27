/**
 * Legal pages.
 *
 * The text below describes what this system actually does with data — the
 * providers it talks to, what it stores, and for how long — rather than generic
 * boilerplate. It is written to be accurate, not to be a substitute for counsel:
 * both documents open with a review notice, and the operator must fill in the
 * company name, jurisdiction and contact address before commercial launch.
 */

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDocument {
  title: string;
  updated: string;
  notice: string;
  sections: LegalSection[];
}

export const LAST_UPDATED = '2026-08-25';

const OPERATOR = '[اسم الجهة المشغِّلة]';
const OPERATOR_EN = '[Operator legal name]';
const CONTACT = '[support@your-domain.com]';
const JURISDICTION = '[الدولة/الولاية القضائية]';
const JURISDICTION_EN = '[jurisdiction]';

export const PRIVACY: Record<'ar' | 'en', LegalDocument> = {
  ar: {
    title: 'سياسة الخصوصية',
    updated: LAST_UPDATED,
    notice:
      'هذه الوثيقة تصف بدقة ما يفعله النظام بالبيانات. راجعها مع مستشار قانوني وأكمل البيانات بين الأقواس قبل الإطلاق التجاري.',
    sections: [
      {
        heading: 'من نحن',
        body: [
          `المنصة يشغّلها ${OPERATOR}. للتواصل بشأن بياناتك: ${CONTACT}.`,
        ],
      },
      {
        heading: 'ما الذي نجمعه',
        body: [
          '**بيانات الحساب:** الاسم والبريد الإلكتروني وكلمة مرور مُجزَّأة بـ bcrypt (لا نخزّن كلمة المرور نفسها أبدًا)، ولغة الواجهة وتاريخ آخر دخول.',
          '**محتوى بحثك:** عنوان المشروع ومجاله وتخصصه ودرجته العلمية وكلماته المفتاحية، وكل قسم تكتبه أو تولّده، وكل نسخة سابقة منه، وملاحظاتك ومراجعك.',
          '**محادثاتك مع المساعد:** نص رسائلك وردود المساعد، مرتبطة بالمشروع الذي دارت فيه.',
          '**قياس الاستخدام:** عدد الطلبات والكلمات المولَّدة وعدد الرموز والتكلفة التقديرية لكل طلب — لتطبيق حدود خطتك وحساب الفاتورة.',
          'لا نستخدم ملفات تتبّع إعلانية، ولا نضع أي أدوات تحليلات خارجية.',
        ],
      },
      {
        heading: 'إلى أين تذهب بياناتك',
        body: [
          '**مزوّد الذكاء الاصطناعي:** عند طلبك توليد نص، تُرسل لقطة من مشروعك (العنوان والمشكلة والأسئلة والأقسام المعتمدة) إلى مزوّد الذكاء الاصطناعي المُعَد في التطبيق لتوليد الرد. لا يُرسل بريدك ولا اسمك.',
          '**مزوّد البريد:** بريدك الإلكتروني فقط، عند إرسال رسالة إعادة تعيين كلمة المرور.',
          '**مزوّد الدفع:** إن فُعِّل الدفع، تُعالَج بيانات بطاقتك لدى مزوّد الدفع مباشرة ولا تمرّ بخوادمنا ولا نخزّنها.',
          '**الاستضافة وقاعدة البيانات:** يعمل التطبيق على منصة استضافة سحابية وقاعدة بيانات PostgreSQL مُدارة.',
        ],
      },
      {
        heading: 'مدة الاحتفاظ',
        body: [
          'يُحتفظ بمشاريعك ومحادثاتك ما دام حسابك قائمًا. عند حذف حسابك تُحذف مشاريعه وأقسامه ونسخه ومحادثاته ومراجعه معه (حذف متسلسل في قاعدة البيانات).',
          'تبقى سجلات الاستخدام المجمَّعة (عدد الطلبات والتكلفة) لأغراض المحاسبة، غير مرتبطة بمحتوى بحثك.',
          'رموز إعادة تعيين كلمة المرور تُخزَّن مجزَّأة وتنتهي صلاحيتها خلال ٣٠ دقيقة، وتُحذف فور استخدامها.',
        ],
      },
      {
        heading: 'حقوقك',
        body: [
          'تستطيع تعديل بياناتك من صفحة الإعدادات، وتصدير أي مشروع إلى ملف Word، وحذف أي مشروع نهائيًا.',
          `لطلب نسخة من بياناتك أو حذف حسابك بالكامل، راسلنا على ${CONTACT}.`,
        ],
      },
      {
        heading: 'الأمان',
        body: [
          'كلمات المرور مُجزَّأة بـ bcrypt، والجلسات موقَّعة وتُخزَّن في كوكيز HttpOnly، وكل طلب يمرّ بتحقق من الملكية قبل الوصول إلى أي مشروع، ومفاتيح المزوّدين لا تصل إلى المتصفّح إطلاقًا.',
          'لا يوجد نظام آمن تمامًا. أبلغنا فورًا إن اشتبهت في وصول غير مصرَّح به إلى حسابك.',
        ],
      },
    ],
  },
  en: {
    title: 'Privacy Policy',
    updated: LAST_UPDATED,
    notice:
      'This document describes accurately what the system does with data. Have it reviewed by counsel and fill in the bracketed details before a commercial launch.',
    sections: [
      {
        heading: 'Who we are',
        body: [`The platform is operated by ${OPERATOR_EN}. For data enquiries: ${CONTACT}.`],
      },
      {
        heading: 'What we collect',
        body: [
          '**Account data:** name, email, a bcrypt-hashed password (never the password itself), interface language, and last sign-in time.',
          '**Your research content:** project title, field, specialisation, degree, keywords, every section you write or generate, every earlier version of it, plus your notes and references.',
          '**Assistant conversations:** your messages and the assistant’s replies, attached to the project they belong to.',
          '**Usage metering:** request counts, generated words, token counts and estimated cost per request — used to enforce your plan limits and to bill.',
          'No advertising trackers and no third-party analytics are used.',
        ],
      },
      {
        heading: 'Where your data goes',
        body: [
          '**AI provider:** when you ask for generated text, a snapshot of your project (title, problem, questions, approved sections) is sent to the configured AI provider to produce the reply. Your name and email are not sent.',
          '**Email provider:** your email address only, when a password-reset message is sent.',
          '**Payment provider:** if billing is enabled, card details are handled by the payment provider directly; they never reach our servers and are not stored by us.',
          '**Hosting and database:** the application runs on a cloud hosting platform with a managed PostgreSQL database.',
        ],
      },
      {
        heading: 'Retention',
        body: [
          'Projects and conversations are kept while your account exists. Deleting your account cascades to its projects, sections, versions, conversations and references.',
          'Aggregated usage records (request counts and cost) are retained for accounting and are not linked to your research content.',
          'Password-reset tokens are stored hashed, expire after 30 minutes, and are deleted the moment they are used.',
        ],
      },
      {
        heading: 'Your rights',
        body: [
          'You can edit your details in Settings, export any project to a Word document, and permanently delete any project.',
          `To request a copy of your data or full account deletion, contact ${CONTACT}.`,
        ],
      },
      {
        heading: 'Security',
        body: [
          'Passwords are bcrypt-hashed, sessions are signed and stored in HttpOnly cookies, every request is ownership-checked before touching a project, and provider API keys never reach the browser.',
          'No system is perfectly secure. Tell us immediately if you suspect unauthorised access to your account.',
        ],
      },
    ],
  },
};

export const TERMS: Record<'ar' | 'en', LegalDocument> = {
  ar: {
    title: 'شروط الاستخدام',
    updated: LAST_UPDATED,
    notice:
      'هذه الوثيقة تصف قواعد استخدام المنصة كما بُنيت فعلًا. راجعها مع مستشار قانوني وأكمل البيانات بين الأقواس قبل الإطلاق التجاري.',
    sections: [
      {
        heading: 'ما تقدّمه المنصة',
        body: [
          'المنصة أداة مساعدة على تنظيم البحث العلمي وكتابته: تقترح عناوين، وتبني خطة بحث، وتكتب مسوّدات أقسام من مدخلاتك، وتعيد صياغة ما تعطيها.',
          'المنصة **لا تكتب بحثك بدلًا عنك ولا تتحمّل مسؤوليته**. كل ما تنتجه مسوّدة تحتاج مراجعتك واعتمادك.',
        ],
      },
      {
        heading: 'النزاهة الأكاديمية — بند أساسي',
        body: [
          'أنت المؤلف الوحيد لبحثك والمسؤول عنه أمام مؤسستك الأكاديمية.',
          'المساعد **لا يتحقق من صحة أي مرجع**. كل استشهاد يقترحه يُعرض بوسم «غير متحقَّق منه»، وعليك فتح المصدر الأصلي والتأكد منه قبل الاستشهاد به. الاستشهاد بمرجع غير موجود مخالفة أكاديمية جسيمة تقع مسؤوليتها عليك وحدك.',
          'المساعد لا يجري تجارب ولا يولّد نتائج. أقسام النتائج والمناقشة تتطلب بياناتك أنت.',
          'تقع على عاتقك مسؤولية الالتزام بلوائح مؤسستك بشأن استخدام أدوات الذكاء الاصطناعي، بما في ذلك الإفصاح عن استخدامها إن كان مطلوبًا.',
        ],
      },
      {
        heading: 'حسابك',
        body: [
          'أنت مسؤول عن سرية كلمة مرورك وعن كل نشاط يجري عبر حسابك.',
          'يجب أن تكون المعلومات التي تقدّمها صحيحة، وأن تكون مؤهلًا قانونًا للتعاقد.',
          'يجوز لنا إيقاف أي حساب يسيء الاستخدام أو يخالف هذه الشروط.',
        ],
      },
      {
        heading: 'ملكية المحتوى',
        body: [
          'محتوى مشاريعك ملكك أنت. لا ندّعي أي حق ملكية فيه، ولا نستخدمه لتدريب نماذج.',
          'تمنحنا ترخيصًا محدودًا بمعالجة محتواك لغرض واحد فقط: تشغيل الخدمة لك.',
        ],
      },
      {
        heading: 'الخطط والاشتراك',
        body: [
          'الخطة المجانية تشمل مشروعًا واحدًا وعددًا محدودًا من طلبات الذكاء الاصطناعي والكلمات شهريًا. عند بلوغ الحد يبقى عملك محفوظًا ويتوقف التوليد حتى الترقية أو بداية الشهر التالي.',
          'اشتراك Pro شهري ويتجدّد تلقائيًا حتى تلغيه. الإلغاء متاح في أي وقت من صفحة الفوترة، وتبقى مزايا Pro حتى نهاية المدة المدفوعة.',
          'الحدود والأسعار المعروضة في صفحة الأسعار هي المرجع، ويجوز تعديلها مع إشعار مسبق.',
        ],
      },
      {
        heading: 'حدود المسؤولية',
        body: [
          'تُقدَّم الخدمة «كما هي». لا نضمن دقة أي نص يولّده الذكاء الاصطناعي ولا صلاحيته لغرضك، ولا نضمن قبول بحثك أو نجاحه.',
          'لا نتحمّل مسؤولية أي ضرر ناتج عن الاعتماد على مخرجات المساعد دون مراجعة، ولا عن أي إجراء تأديبي أكاديمي يترتب على استخدامك للأداة.',
        ],
      },
      {
        heading: 'القانون الحاكم',
        body: [`تخضع هذه الشروط لقوانين ${JURISDICTION}. للتواصل: ${CONTACT}.`],
      },
    ],
  },
  en: {
    title: 'Terms of Use',
    updated: LAST_UPDATED,
    notice:
      'This document describes the rules of use as the platform is actually built. Have it reviewed by counsel and fill in the bracketed details before a commercial launch.',
    sections: [
      {
        heading: 'What the platform provides',
        body: [
          'The platform is a tool for structuring and writing academic research: it proposes titles, builds a research plan, drafts sections from your inputs, and rewrites what you give it.',
          'It **does not write your thesis for you and takes no responsibility for it**. Everything it produces is a draft that requires your review and approval.',
        ],
      },
      {
        heading: 'Academic integrity — core clause',
        body: [
          'You are the sole author of your research and answerable for it to your institution.',
          'The assistant **does not verify references**. Every citation it proposes is shown as “unverified”; you must open the original source and confirm it before citing. Citing a source that does not exist is serious academic misconduct and is your responsibility alone.',
          'The assistant runs no experiments and produces no findings. Results and discussion sections require your own data.',
          'Complying with your institution’s rules on AI assistance — including disclosing its use where required — is your responsibility.',
        ],
      },
      {
        heading: 'Your account',
        body: [
          'You are responsible for keeping your password confidential and for all activity under your account.',
          'Information you provide must be accurate, and you must be legally able to enter into this agreement.',
          'We may suspend any account that abuses the service or breaches these terms.',
        ],
      },
      {
        heading: 'Content ownership',
        body: [
          'Your project content is yours. We claim no ownership in it and do not use it to train models.',
          'You grant us a limited licence to process your content for one purpose only: operating the service for you.',
        ],
      },
      {
        heading: 'Plans and subscription',
        body: [
          'The free plan includes one project and a limited monthly allowance of AI requests and generated words. On reaching the limit your work is kept and generation pauses until you upgrade or the month resets.',
          'Pro is billed monthly and renews until cancelled. You can cancel at any time from the billing page and keep Pro access until the end of the paid period.',
          'The limits and prices shown on the pricing page govern, and may change with prior notice.',
        ],
      },
      {
        heading: 'Limitation of liability',
        body: [
          'The service is provided “as is”. We do not warrant the accuracy or fitness of any AI-generated text, nor that your research will be accepted.',
          'We are not liable for loss arising from relying on assistant output without review, nor for any academic disciplinary outcome resulting from your use of the tool.',
        ],
      },
      {
        heading: 'Governing law',
        body: [`These terms are governed by the laws of ${JURISDICTION_EN}. Contact: ${CONTACT}.`],
      },
    ],
  },
};
