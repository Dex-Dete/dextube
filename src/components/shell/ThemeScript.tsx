/**
 * Applies the stored theme before first paint to avoid a flash of the wrong
 * palette. Rendered inline in <head>; it is intentionally tiny and has no
 * dependency on React hydration.
 */
export function ThemeScript() {
  const code = `(function(){try{
var s=localStorage.getItem('dextube-theme');
var m=window.matchMedia('(prefers-color-scheme: dark)').matches;
var t=s==='light'||s==='dark'?s:(m?'dark':'light');
document.documentElement.setAttribute('data-theme',t);
var r=localStorage.getItem('dextube-reduce-motion');
if(r==='true')document.documentElement.setAttribute('data-reduce-motion','true');
}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
