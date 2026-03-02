import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // Skip internal build since Cloudflare already runs npm run build
  buildCommand: "next build",
});
