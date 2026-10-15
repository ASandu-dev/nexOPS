/**
 * Inline theme bootstrap. Runs during HTML parse, before the shell paints, so
 * the correct theme class is on <html> and there is no light/dark flash.
 *
 * Kept as a plain string (not a module) so it can be inlined verbatim.
 */
const THEME_INIT_SCRIPT = `(function(){try{var k='nexops-theme';var s=localStorage.getItem(k);var d=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
}
