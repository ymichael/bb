function themeInit(darkQuery) {
  if (matchMedia(darkQuery).matches) {
    document.documentElement.classList.add("dark");
  }
}
