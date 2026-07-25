/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // the Python AI engine runs separately; the app talks to it over HTTP
  env: {
    NEXT_PUBLIC_APP_NAME: "Ajace Timesheets",
  },
};
module.exports = nextConfig;
