# NetApp ONTAP MCP — Desktop Extension

Installs NetApp's official open-source [ONTAP-MCP server](https://github.com/NetApp/ontap-mcp)
as a Claude Desktop extension, so Claude can query and manage your ONTAP storage clusters
directly.

## Why this exists

ONTAP-MCP ships only as a Docker container speaking Streamable HTTP — it has no stdio mode.
Claude Desktop's custom connector feature requires a server reachable from the public internet,
which a server sitting in front of your storage cluster usually isn't and shouldn't be. Desktop
Extensions solve both problems: this extension runs entirely on your own machine and talks to
Claude Desktop over stdio, exactly like any other local extension.

Under the hood, `server/index.js`:

1. Writes an `ontap.yaml` config file (from your settings below) to
   `~/.ontap-mcp-desktop-extension/`.
2. Starts the `ghcr.io/netapp/ontap-mcp` Docker container, published **only** to `127.0.0.1`
   on your machine — never exposed to your network or the internet.
3. Waits for it to report healthy, then bridges Claude Desktop's stdio connection to that local
   HTTP server using [`mcp-remote`](https://github.com/punkpeye/mcp-remote) (bundled — no
   internet access needed at runtime for this part).

## Requirements

- **Docker Desktop** (or another Docker engine) installed and running on your machine.
- Network connectivity from your machine to your ONTAP cluster's management LIF.
- ONTAP admin credentials.

## Settings

| Setting | Notes |
|---|---|
| ONTAP Cluster Address | Hostname or IP of the cluster's management LIF |
| ONTAP Username / Password | Password is stored by Claude Desktop and written only to a local file, mounted read-only into the container |
| Skip TLS Certificate Verification | On by default — most on-prem clusters use self-signed certs |
| Read-Only Mode | **On by default.** No provisioning/deletion tools are registered until you turn this off |
| Docker Image | Defaults to `ghcr.io/netapp/ontap-mcp:latest` |
| Local Port | Host port the container is published on (127.0.0.1 only); change if 8083 is taken |
| Additional Clusters (advanced) | Raw YAML to add more `Pollers` entries for multi-cluster setups |

## Security notes

- ONTAP-MCP has **no built-in authentication** of its own unless you separately configure OAuth
  (not covered by this extension) — anything that can reach the assistant using this extension
  can use these tools. The container's port is bound to `127.0.0.1` only, so nothing on your
  network can reach it directly.
- Read-Only Mode is on by default specifically because of the above — turn it off only when you
  intend for Claude to make changes to your storage systems.

## Troubleshooting

Logs (including all Docker container output) are written to:

```
~/.ontap-mcp-desktop-extension/container.log
```

If the extension fails to start, check that file first — most issues are either "Docker isn't
running" or "the configured port is already in use."

## Building this bundle yourself

```bash
npm install -g @anthropic-ai/mcpb
cd ontap-mcp-extension
npm install --production   # bundles mcp-remote into node_modules/
mcpb pack . ontap-mcp.mcpb
```
