/**
 * The disclosure, word for word, wherever simulated data is spoken of.
 *
 * In a module of its own so that an export route or a generator can print it
 * without importing the simulation service and, through it, the model
 * providers and the database.
 */
export const SIMULATED_NOTICE: Record<'ar' | 'en', string> = {
  ar: 'بيانات محاكاة — ليست بيانات الدراسة. وُلِّدت حسابيًا لتُعيد إنتاج الإحصاءات المنشورة في البحث، لأغراض التدريس والتدرّب على التحليل فقط. لا يجوز عرضها أو الاستشهاد بها على أنها بيانات حقيقية جُمعت من مستجيبين؛ فذلك تلفيق بيانات.',
  en: 'SIMULATED DATA — not the study’s data. Generated arithmetically to reproduce the statistics published in the paper, for teaching and analysis practice only. It must not be presented or cited as real data collected from respondents; doing so is data fabrication.',
};

