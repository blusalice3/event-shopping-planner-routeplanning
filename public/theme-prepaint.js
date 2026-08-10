(function () {
  "use strict";

  var storedTheme = null;
  try {
    storedTheme = localStorage.getItem("themeMode");
  } catch {
    storedTheme = null;
  }
  var theme =
    storedTheme === "dark" || storedTheme === "light" ? storedTheme : "system";
  var prefersDark =
    theme === "system" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  var useDark = theme === "dark" || prefersDark;

  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.classList.toggle("dark", useDark);
})();
