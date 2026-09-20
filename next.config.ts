import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // 沙箱预览域名跨源加载 _next 资源时不再告警
  allowedDevOrigins: ["*.space-z.ai"],
};

export default nextConfig;
