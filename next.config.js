/** @type {import('next').NextConfig} */

// Defence-in-depth headers. The CSP matters most: even if hostile content made
// it into a page, it could not load external script or exfiltrate to another
// origin. 'unsafe-inline' for styles is required by this app's inline style
// props; script-src is NOT given unsafe-eval in production.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      process.env.NODE_ENV === "production"
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
  },
];

// HSTS is only meaningful — and only safe — once the site is actually on HTTPS.
// Sending it while serving plain HTTP on a raw IP would lock users out.
if (process.env.COOKIE_SECURE === "true") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  });
}

const nextConfig = {
  // Deploys must NEVER build into the directory the live server is reading.
  // `next start` resolves every static chunk and every not-yet-required server
  // bundle from distDir BY PATH, at request time (next/dist/server/require.js
  // requirePage(), router-utils/filesystem.js nextStaticFolderPath), and it
  // re-reads BUILD_ID from distDir on boot. So a build that empties .next takes
  // payroll down for the whole build, and any restart in that window dies with
  // "Could not find a production build in the '.next' directory".
  //
  // deploy/scripts/install.sh therefore builds with NEXT_DIST_DIR=.next.build
  // and renames the finished directory into place. `next start` runs WITHOUT
  // that variable, so the SERVER always reads plain `.next` — distDir is loaded
  // from this file at runtime, never baked into the build output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_NAME: "Ajace Timesheets",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
module.exports = nextConfig;
