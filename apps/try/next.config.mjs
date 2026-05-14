/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    poweredByHeader: false,
    reactStrictMode: true,
    // The root tsconfig.eslint.json doesn't include apps/try paths, so Next's
    // default lint-during-build fails with parser errors. Skip — tsc still
    // typechecks during build and we can wire a dedicated eslint config later.
    eslint: {
        ignoreDuringBuilds: true,
    },
};

export default nextConfig;
