import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.PORT ?? "5173";

const child = spawn(
  path.join(root, "node_modules/.bin/astro"),
  ["dev", "--host", "127.0.0.1", "--port", port],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      NODE_ENV: "development",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 0));
