import { AlertTriangle, ArrowLeft } from "lucide-react";
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { AppSurface, EmptyState } from "../components/ui";

export function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();

  let title = "Что-то пошло не так";
  let message = "Не удалось отрисовать страницу. Проверьте API и попробуйте обновить экран.";

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    message = typeof error.data === "string" && error.data ? error.data : message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <AppSurface>
      <div className="flex min-h-[70vh] items-center justify-center">
        <div className="w-full max-w-2xl space-y-6">
          <EmptyState title={title} text={message} />
          <div className="glass-panel rounded-[30px] p-4">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="metric-chip inline-flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium text-[var(--color-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
              >
                <ArrowLeft className="size-4" />
                Назад
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 rounded-2xl bg-[var(--color-active-bg)] px-4 py-3 text-sm font-medium text-[var(--color-active-ink)] transition hover:bg-[var(--color-active-bg-hover)]"
              >
                <AlertTriangle className="size-4" />
                Перезагрузить
              </button>
            </div>
          </div>
        </div>
      </div>
    </AppSurface>
  );
}
