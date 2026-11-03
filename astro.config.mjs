import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { access as cloudflareAccess, d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import { loadEnv } from "vite";

const fileEnv = loadEnv(process.env.NODE_ENV || "development", process.cwd(), "");
const emdashAccessTeamDomain = (process.env.EMDASH_ACCESS_TEAM_DOMAIN || fileEnv.EMDASH_ACCESS_TEAM_DOMAIN || "jolly-cake-2b85.cloudflareaccess.com").trim();

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
      admin: {
        locales: ["en"],
        siteName: "Foilbury Editorial",
        logo: "/brand/wordmark.png",
        favicon: "/brand/favicon-32.png",
        footerLabel: "Foilbury · editorial operator console",
      },
      // Access stays enabled even when the build has no private environment file.
      // EmDash reads the deployed Worker binding and handles local dev passkeys.
      auth: cloudflareAccess({
        teamDomain: emdashAccessTeamDomain,
        audienceEnvVar: "FOILBURY_ACCESS_EDITORIAL_AUD",
        autoProvision: false,
        syncRoles: false,
        syncName: true,
        defaultRole: 50,
      }),
      maxUploadSize: 8 * 1024 * 1024,
      toolbar: false,
    }),
  ],
  vite: { plugins: [tailwindcss()] },
  devToolbar: { enabled: false },
});

