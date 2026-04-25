import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

function reactSpaDevEntrypoint(): Plugin {
  return {
    name: "xway-react-spa-dev-entrypoint",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const requestUrl = new URL(request.url || "/", "http://localhost");
        const pathname = requestUrl.pathname.replace(/\/$/, "") || "/";
        if (pathname === "/" || pathname === "/catalog" || pathname === "/product") {
          request.url = `/index.react.html${requestUrl.search}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [reactSpaDevEntrypoint(), react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, "index.react.html"),
      },
    },
  },
});
