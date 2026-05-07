import type { NextConfig } from "next";

const nextConfig: NextConfig & { eslint?: { ignoreDuringBuilds?: boolean } } = {
  reactStrictMode: true,
  turbopack: {},
  serverExternalPackages: ["canvas", "node-canvas"],

  typescript: {
    ignoreBuildErrors: true,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;