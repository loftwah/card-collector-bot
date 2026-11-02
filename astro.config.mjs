import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://foilbury.loftwah.com",
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  security: {
    checkOrigin: true,
    csp: {
      directives: [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "connect-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "frame-src 'none'",
      ],
      scriptDirective: { resources: ["'self'"] },
      styleDirective: { resources: ["'self'", "'unsafe-inline'"] },
    },
  },
  integrations: [
    react(),
    emdash({
      database: d1({ binding: "DB", session: "disabled" }),
      storage: r2({ binding: "MEDIA" }),
      admin: { locales: ["en"] },
      maxUploadSize: 8 * 1024 * 1024,
      toolbar: false,
    }),
  ],
  vite: { plugins: [tailwindcss()] },
  devToolbar: { enabled: false },
});
