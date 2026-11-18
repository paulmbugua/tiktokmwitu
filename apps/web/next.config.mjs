
const api = process.env.INTERNAL_API_URL ?? 'http://127.0.0.1:4000';
const cloudflare = process.env.MWITU_STATIC_EXPORT === '1';

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  ...(cloudflare
    ? { output: 'export' }
    : {
        async rewrites() {
          return [
            { source: '/api/:path*', destination: api + '/api/:path*' },
            { source: '/media/:path*', destination: api + '/media/:path*' },
          ];
        },
      }),
};

export default config;
