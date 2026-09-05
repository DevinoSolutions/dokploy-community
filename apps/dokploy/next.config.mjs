/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */

/** @type {import("next").NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	typescript: {
		ignoreBuildErrors: true,
	},
	transpilePackages: ["@dokploy/server"],
	// OAuth discovery for the remote MCP server: clients probe the origin
	// root (RFC 8414 / RFC 9728), the documents are built in pages/api/mcp-oauth/*.
	async rewrites() {
		return [
			{
				source: "/.well-known/oauth-protected-resource",
				destination: "/api/mcp-oauth/protected-resource",
			},
			{
				source: "/.well-known/oauth-protected-resource/:path*",
				destination: "/api/mcp-oauth/protected-resource",
			},
			{
				source: "/.well-known/oauth-authorization-server",
				destination: "/api/mcp-oauth/authorization-server",
			},
			{
				source: "/.well-known/openid-configuration",
				destination: "/api/mcp-oauth/authorization-server",
			},
		];
	},
	async headers() {
		return [
			{
				// Apply security headers to all routes
				source: "/:path*",
				headers: [
					{
						key: "X-Frame-Options",
						value: "DENY",
					},
					{
						key: "Content-Security-Policy",
						value: "frame-ancestors 'none'",
					},
					{
						key: "X-Content-Type-Options",
						value: "nosniff",
					},
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
				],
			},
		];
	},
};

export default nextConfig;
