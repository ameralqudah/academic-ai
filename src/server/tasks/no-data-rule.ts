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
