import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {}, // ← add this to silence the error
  env: {
    // Identifies this build (shown under the viewer's "i" details; versions the service worker).
    NEXT_PUBLIC_BUILD_ID: new Date().toISOString().slice(0, 16).replace('T', ' '),
  },
  async headers() {
    return [
      {
        // The service worker must never be served stale.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        canvas: false,
      };
    }
    return config;
  },
};

export default nextConfig;