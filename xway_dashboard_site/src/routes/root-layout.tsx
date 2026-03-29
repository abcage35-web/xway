import { useEffect } from "react";
import { Outlet, useLocation, useNavigation } from "react-router";
import { AppSurface, LoadingBar, LoadingOverlay } from "../components/ui";

export function RootLayout() {
  const navigation = useNavigation();
  const location = useLocation();
  const isLoading = navigation.state !== "idle";
  const navigationPathname = navigation.location?.pathname ?? null;
  const preserveProductScreenWhileLoading =
    location.pathname.startsWith("/product") &&
    navigationPathname === location.pathname;
  const showLoadingOverlay = isLoading && !preserveProductScreenWhileLoading;

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
      <AppSurface>
        <main className="relative flex-1">
          <Outlet />
          <LoadingOverlay active={showLoadingOverlay} />
        </main>
      </AppSurface>
    </>
  );
}
