
const api = process.env.INTERNAL_API_URL ?? 'http://127.0.0.1:4000';
const cloudflare = process.env.MWITU_STATIC_EXPORT === '1';

/** @type {import('next').NextConfig} */
const config = {
  agentRules: false,
  poweredByHeader: false,
  ...(cloudflare
    ? { output: 'export' }
    : {
        async redirects() {
          return [
            { source: '/watch/:id', destination: '/?v=:id&app=1', permanent: false },
            { source: '/videos', destination: '/?browse=videos', permanent: false },
            { source: '/live', destination: '/?browse=live', permanent: false },
          ];
        },
        async rewrites() {
          return [
            { source: '/api/:path*', destination: api + '/api/:path*' },
            { source: '/media/:path*', destination: api + '/media/:path*' },
          ];
        },
      }),
};

export default config;
