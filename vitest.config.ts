import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run in workerd with local KV and R2. The Worker is configured inline
// rather than from wrangler.jsonc, whose deploy-time placeholders stay unfilled
// in this repo.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-01",
        kvNamespaces: ["FEED_CAPTURE"],
        r2Buckets: ["FEED_CAPTURE_R2"],
      },
    }),
  ],
});
