/**
 * Inline theme bootstrap. Runs during HTML parse in <head>, before paint, so
 * the correct theme class is on <html> and there is no light/dark flash.
 *
 * Kept as a plain string (not a module) so it can be inlined verbatim.
 * Reads cookie first (server source of truth), falls back to localStorage,
 * then system preference. Writes cookie so subsequent server renders are correct.
 */
const THEME_INIT_SCRIPT = `(function(){try{var k='nexops-theme';function getCookie(n){var m=document.cookie.match(new RegExp('(^| )'+n.replace(/([.$?*|{}()\\[\\]\\\\\/\+^])/g,'\\\\$1')+'=([^;]+)'));return m?decodeURIComponent(m[2]):null;}var c=getCookie(k);var s=c||localStorage.getItem(k);var d=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;var r=document.documentElement;r.classList.toggle('dark',d);try{document.cookie=k+'='+(d?'dark':'light')+'; Path=/; SameSite=Lax; Max-Age=31536000';}catch(e){}try{localStorage.setItem(k,d?'dark':'light');}catch(e){}}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
}
