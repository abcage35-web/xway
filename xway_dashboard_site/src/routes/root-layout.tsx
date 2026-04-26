import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { Outlet, useLocation, useNavigation } from "react-router";
import { AppSurface, LoadingBar, LoadingOverlay } from "../components/ui";

type AppTheme = "light" | "dark";

const APP_THEME_STORAGE_KEY = "xway-dashboard-theme";

function readStoredTheme(): AppTheme {
  if (typeof window === "undefined") {
    return "light";
  }
  try {
    return window.localStorage.getItem(APP_THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: AppTheme;
  onChange: (theme: AppTheme) => void;
}) {
  const nextTheme = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      aria-label={theme === "light" ? "Включить темную тему" : "Включить светлую тему"}
      title={theme === "light" ? "Включить темную тему" : "Включить светлую тему"}
      onClick={() => onChange(nextTheme)}
      className="theme-settings-button"
    >
      <Settings className="size-5" />
    </button>
  );
}

export function RootLayout() {
  const navigation = useNavigation();
  const location = useLocation();
  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme());
  const isLoading = navigation.state !== "idle";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    try {
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage can be unavailable in private or restricted contexts.
    }
  }, [theme]);

  useEffect(() => {
    const body = document.body;
    body.classList.remove("page-view-product", "page-view-articles");
    if (location.pathname.startsWith("/catalog")) {
      body.classList.add("page-view-articles");
    } else if (location.pathname.startsWith("/product")) {
      body.classList.add("page-view-product");
    }
    return () => {
      body.classList.remove("page-view-product", "page-view-articles");
    };
  }, [location.pathname]);

  return (
    <>
      <LoadingBar active={isLoading} />
      <ThemeToggle theme={theme} onChange={setTheme} />
      <AppSurface>
        <main className="relative flex-1">
          <Outlet />
          <LoadingOverlay active={isLoading} />
        </main>
      </AppSurface>
    </>
  );
}
