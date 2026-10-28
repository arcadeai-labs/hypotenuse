import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { viteDevServerTunnel } from "./devTunnel.ts";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Vite only exposes `VITE_`-prefixed vars to client code and does not load
  // `.env` into `process.env` for this file. Load the whole `.env` so the dev
  // server binds the `PORT` the environment asks for — an origin that must also
  // appear in the backend's `WEB_SERVER_ALLOWED_ORIGINS`.
  const env = loadEnv(mode, import.meta.dirname, "");

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.PORT) || 3000,
      // Fail loudly rather than drift to another port, which would break CORS
      // against the backend's fixed allow-list.
      strictPort: true,
      ...viteDevServerTunnel(env.VITE_DEV_TUNNEL_HOST),
    },
    resolve: {
      // End-to-end types with no codegen: the frontend imports action response
      // types straight from the backend. Configured twice — here and in
      // `tsconfig.app.json` `paths` — and the two must agree.
      alias: {
        "@backend": path.resolve(import.meta.dirname, "../backend"),
      },
    },
    build: { outDir: "dist" },
  };
});
