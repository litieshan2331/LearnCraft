import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker 开发容器通过 0.0.0.0 监听，浏览器以本机回环地址访问时需要显式允许 HMR 来源。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
