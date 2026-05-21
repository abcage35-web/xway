import { createBrowserRouter, redirect } from "react-router";
import { RouteLoadingScreen } from "../components/ui";
import { DEFAULT_ARTICLES } from "../lib/api";
import { getTodayIso, shiftIsoDate } from "../lib/format";
import { RouteErrorBoundary } from "../routes/error-boundary";
import { AiPage } from "../routes/ai-page";
import { catalogLoader, CatalogPage } from "../routes/catalog-page";
import { DrrAnalyticsPage } from "../routes/drr-analytics-page";
import { PachkaReportPage } from "../routes/pachka-report-page";
import { productLoader, ProductPage } from "../routes/product-page";
import { RootLayout } from "../routes/root-layout";

function defaultProductPath() {
  const params = new URLSearchParams();
  params.set("articles", DEFAULT_ARTICLES[0]!);
  return `/product?${params.toString()}`;
}

function defaultCatalogPath() {
  const today = getTodayIso();
  const end = shiftIsoDate(today, -1);
  const start = shiftIsoDate(end, -6);
  const params = new URLSearchParams();
  params.set("start", start);
  params.set("end", end);
  return `/catalog?${params.toString()}`;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    hydrateFallbackElement: <RouteLoadingScreen />,
    errorElement: <RouteErrorBoundary />,
    children: [
      {
        index: true,
        loader: () => redirect(defaultCatalogPath()),
      },
      {
        path: "product",
        loader: productLoader,
        element: <ProductPage />,
        hydrateFallbackElement: <RouteLoadingScreen />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: "catalog",
        loader: catalogLoader,
        element: <CatalogPage />,
        hydrateFallbackElement: <RouteLoadingScreen />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: "ai",
        element: <AiPage />,
        hydrateFallbackElement: <RouteLoadingScreen />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: "drr-analytics",
        element: <DrrAnalyticsPage />,
        hydrateFallbackElement: <RouteLoadingScreen />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: "pachka-report",
        element: <PachkaReportPage />,
        hydrateFallbackElement: <RouteLoadingScreen />,
        errorElement: <RouteErrorBoundary />,
      },
    ],
  },
  {
    path: "*",
    loader: () => redirect(defaultCatalogPath()),
  },
]);
