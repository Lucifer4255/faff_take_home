/** @type {import('next').NextConfig} */
const nextConfig = {
  // Mastra + its storage/telemetry deps are server-only native-ish packages;
  // keep them external to the server bundle so Next doesn't try to bundle them.
  serverExternalPackages: ['@mastra/core', '@mastra/libsql', '@mastra/observability', '@libsql/client'],
}

export default nextConfig
