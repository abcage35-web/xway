import { ACCESS_PERMISSIONS, requireAccessPermission } from "../access-control.js";

export function isAiRoute(pathname) {
  return String(pathname || "").startsWith("/api/ai/");
}

export function requireAiAuth(context) {
  return requireAccessPermission(context, ACCESS_PERMISSIONS.RUN_ANALYSIS, { errorPrefix: "AI API" });
}
