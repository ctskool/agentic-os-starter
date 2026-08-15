import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: __dirname,
  // no eslint setup in this repo (quality gates = tsc + npm test); Next's
  // built-in build lint fails on react-compiler-prep rules (refs-in-render in
  // the three.js cores, Date.now() in HUD render) that are deliberate here.
  // A real eslint config is distribution-repo work.
  eslint: { ignoreDuringBuilds: true },
  // CORS on the voice endpoints — the Obsidian cockpit's orb runs on the
  // app:// origin and needs streaming <audio> (and plain fetch) against
  // :3107. Local-only server, so the wildcard is fine.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
        ],
      },
    ];
  },
};

export default nextConfig;
