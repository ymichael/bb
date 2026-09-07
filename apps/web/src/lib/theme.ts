import themeInitSource from "./theme-init.js?raw";

export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export const THEME_INIT = `(${themeInitSource})(${JSON.stringify(
  DARK_SCHEME_QUERY,
)})`;

export function watchSystemTheme(): () => void {
  const media = matchMedia(DARK_SCHEME_QUERY);
  const apply = () => {
    document.documentElement.classList.toggle("dark", media.matches);
  };
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
