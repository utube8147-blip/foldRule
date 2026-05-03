import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {},
  serverExternalPackages: ["canvas", "node-canvas"],
};

export default nextConfig;
