/**
 * Vite `server` fields that make a reserved HTTPS tunnel hostname work.
 *
 * Vite 6+ refuses unknown `Host` headers, and HMR defaults to the page's
 * port — 443 on the tunnel, 3000 on the process. Both have to be named when
 * `VITE_DEV_TUNNEL_HOST` is set.
 */

/** What {@link viteDevServerTunnel} adds onto `server`. */
export interface ViteDevServerTunnel {
  /** Hostnames Vite will accept on incoming requests. */
  allowedHosts: string[];
  /** Client-side HMR socket, aimed at the public HTTPS endpoint. */
  hmr: {
    host: string;
    protocol: "wss";
    clientPort: number;
  };
}

/**
 * Translate a public tunnel hostname into Vite `server` options.
 * @param tunnelHost - Hostname only, no scheme. Empty / unset is a no-op.
 * @returns Fields to spread onto `server`, or `undefined` when unused.
 */
export function viteDevServerTunnel(
  tunnelHost: string | undefined,
): ViteDevServerTunnel | undefined {
  const host = tunnelHost?.trim();
  if (!host) return undefined;
  return {
    allowedHosts: [host],
    hmr: { host, protocol: "wss", clientPort: 443 },
  };
}
