
const api = process.env.INTERNAL_API_URL ?? 'http://127.0.0.1:4000';

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: api + '/api/:path*' },
      { source: '/media/:path*', destination: api + '/media/:path*' },
    ];
  },
};

export default config;
