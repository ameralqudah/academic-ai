/**
 * Applies the stored theme before first paint so a dark-mode user never sees a
 * white flash. Kept as a raw string on purpose — it must run before hydration.
 */
const script = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = stored === 'DARK' || ((!stored || stored === 'SYSTEM') && prefersDark);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} suppressHydrationWarning />;
}
