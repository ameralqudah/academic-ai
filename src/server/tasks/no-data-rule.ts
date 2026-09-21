/**
 * What a writing step is told when no analysis stands behind it.
 *
 * Asked for "a complete paper" with a Results section, the model wrote one:
 * hypotheses "supported", effects "significant" — for a study that was never
 * run, on data that does not exist. It read well, passed the citation check
 * (the sentences were cited), and would have been submitted. Inventing findings
 * is the one thing an academic tool must not do on a researcher's behalf.
 *
 * The rule does not refuse the section. A proposal legitimately has a results
 * part — a planned analysis and what each outcome would mean — so the step
 * writes that, and says at the top which of the two it is.
 *
 * Pure, and in its own module, so it can be tested without the handlers' reach
 * into the database and the model providers.
 */
export function noDataRule(language: "ar" | "en"): string {
  return language === "ar"
    ? "\n\nلم تُحلَّل أي بيانات لهذا المستند، ولم تُجرَ أي دراسة ميدانية. لا تذكر نتائج أو إحصاءات أو أحجام عينات، ولا تقل إن فرضيةً دُعمت أو رُفضت. إذا طُلب قسم للنتائج أو المناقشة فاكتبه بوصفه «خطة التحليل والنتائج المتوقعة» بصيغة المستقبل أو الاحتمال، وابدأه بجملة صريحة تفيد أن جمع البيانات لم يتم بعد."
    : '\n\nNo data was analysed for this document and no study has been carried out. Do not report results, statistics or sample sizes, and do not say that a hypothesis was supported or rejected. If a results, findings or discussion part is asked for, write it as "Planned analysis and expected results", in the future or conditional tense, and open it with one plain sentence saying that data collection has not yet taken place.';
}

/**
 * What a writing step is told when the analysis behind it ran on simulated data.
 *
 * The rule above switches off as soon as an analysis exists, because an
 * analysis is what makes a finding real. A simulated dataset breaks that
 * inference: the analysis is genuine arithmetic, on respondents who do not
 * exist. Left alone, "generate data from this paper, run PLS, write the
 * results" would produce a results chapter indistinguishable from a real one —
 * the fabrication this product exists to refuse, reached in three polite steps.
 *
 * Writing is still allowed. A student practising a results section needs to
 * write one, and a lecturer needs a worked example. What is not allowed is
 * text that could be lifted into a paper as a finding, so the disclosure is
 * required at the top and the numbers are attributed to the simulation every
 * time they are interpreted.
 */
export function simulatedDataRule(language: 'ar' | 'en'): string {
  return language === 'ar'
    ? '\n\nنتائج التحليل أعلاه محسوبة من بيانات محاكاة وُلِّدت حسابيًا لأغراض تعليمية، لا من بيانات جُمعت من مستجيبين. ابدأ النص بهذه الجملة حرفيًا: «تنبيه: هذا النص تمرين تعليمي مبني على بيانات محاكاة، وليس نتائج دراسة ميدانية، ولا يجوز نشره أو الاستشهاد به بوصفه نتائج بحث.» ثم اكتب القسم بوصفه مثالًا تدريبيًا، وانسب كل رقم إلى «البيانات المحاكاة». لا تقل إن فرضيةً دُعمت أو رُفضت في الواقع، ولا تستخلص توصيات أو دلالات عملية للميدان.'
    : '\n\nThe analysis results above were computed from simulated data, generated arithmetically for teaching, not from data collected from respondents. Open the text with this sentence, verbatim: "Notice: this text is a teaching exercise based on simulated data. It does not report the results of a study and must not be published or cited as research findings." Then write the section as a worked practice example, attributing every figure to "the simulated data". Do not say a hypothesis was supported or rejected in reality, and do not draw recommendations or practical implications for the field.';
}

/** Whether any analysis payload in a list came from a simulated dataset. */
export function anySimulated(results: Record<string, unknown>[]): boolean {
  return results.some((result) => result?.simulated === true);
}
