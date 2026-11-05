import { pathToFileURL } from 'node:url';

/** Select browser journeys by changed behavior; unit and Worker checks still run. */
export function affectedJourneys(paths) {
  const matches = expression => paths.some(file => expression.test(file));
  // Shared server wiring, dependencies and migrations can affect every journey.
  const shared = matches(/^(?:package\.json|pnpm-lock\.yaml|astro\.config\.|wrangler[^/]*|migrations\/|src\/middleware\.ts|src\/server\/(?:context|http|ids)\.|src\/server\/api\/|src\/pages\/api\/v1\/\[\.\.\.path\]\.ts)/);
  const auth = shared || matches(/^src\/(?:pages\/(?:api\/v1\/auth|api\/v1\/security|login|security)|server\/(?:access|password|modules\/(?:identity|membership|magic-links|strong-session))|components\/(?:LoginForm|security))|^tests\/.*(?:auth|access|security)/i);
  const editorial = shared || matches(/^(?:emdash\.config|src\/(?:pages\/(?:journal|_emdash)|server\/modules\/journal)|tests\/.*(?:editorial|emdash)|scripts\/test-editorial)/i);
  const album = shared || matches(/^src\/(?:pages\/(?:play\/(?:collection|collections|card|wishlist|rewards|gifts)|media|cabinet|s\/|api\/v1\/(?:admin|collections|cards|pools|draws|media|shares))|components\/(?:player\/(?:Collection|Card|Published|Share|Wishlist|Gift|Reward)|admin|platform|studio)|server\/modules\/(?:achievements|assets|catalogue|collection|collections|economy|gifts|imports|media|missions|npcs|pools|prints|set-management|shares|trades|visibility|wallet))|^tests\/(?:workers|unit|scripts)\/.*(?:album|inventory|draw|collection|gift|visibility)/i);
  const privacy = shared || album || matches(/^src\/server\/|^tests\/.*(?:privacy|tenancy|discord)/i);
  return { auth, editorial, album, privacy, browser: auth || editorial || album || privacy };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs');
  const paths = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean);
  for (const [name, value] of Object.entries(affectedJourneys(paths))) console.log(`${name}=${value}`);
}
