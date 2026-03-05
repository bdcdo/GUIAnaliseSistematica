import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["recharts", "lucide-react", "framer-motion"],
  },
};

export default nextConfig;
