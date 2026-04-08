import { readFileSync, watch } from "fs";

const IS_PROD = process.argv.includes("--prod");

function loadManifest() {
  return JSON.parse(readFileSync("./deverse.json", "utf-8"));
}

let manifest = loadManifest();

// Watch deverse.json for changes — scaffold_artifact() writes here atomically
watch("./deverse.json", { persistent: false }, (event) => {
  if (event === "change") {
    try {
      manifest = loadManifest();
      console.log(`[router] deverse.json reloaded — ${manifest.artifacts.length} artifact(s)`);
    } catch (e) {
      console.error("[router] Failed to reload deverse.json (keeping old manifest):", e);
    }
  }
});

function findArtifact(pathname: string) {
  return [...manifest.artifacts]
    .sort((a: any, b: any) => b.path.length - a.path.length)
    .find((a: any) => pathname.startsWith(a.path));
}

async function serveStatic(filePath: string): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file);
}

type WSData = { port: number; path: string; upstream?: WebSocket };

Bun.serve<WSData>({
  port: 3000,

  async fetch(req, server) {
    const url = new URL(req.url);

    // ── Health check — always available, even with 0 artifacts ──────────────
    if (url.pathname === "/health")
      return Response.json({ status: "ok" });

    // ── Shared workspace assets (served in BOTH dev and prod) ────────────────
    // /assets/ → workspace-level shared brand assets (logo, fonts, favicons)
    //   Any artifact references as: <img src="/assets/brand/logo.png" />
    if (url.pathname.startsWith("/assets/"))
      return serveStatic(`.${url.pathname}`);

    // /data/ → CSV/JSON data files uploaded by user via chat
    //   Django saves uploaded CSVs to workspace/data/
    //   artifact-data-visualization fetches /data/dataset.csv
    if (url.pathname.startsWith("/data/"))
      return serveStatic(`.${url.pathname}`);

    // ── WebSocket upgrade (dev mode only — Vite HMR) ─────────────────────────
    if (!IS_PROD && req.headers.get("upgrade") === "websocket") {
      const artifact = findArtifact(url.pathname);
      if (!artifact) return new Response("Not found", { status: 404 });
      const upgraded = server.upgrade(req, {
        data: { port: artifact.localPort, path: url.pathname },
      });
      if (upgraded) return undefined;
      return new Response("WS upgrade failed", { status: 500 });
    }

    // ── Artifact routing ──────────────────────────────────────────────────────
    const artifact = findArtifact(url.pathname);
    if (!artifact) return new Response("Not found", { status: 404 });

    if (IS_PROD) {
      const strippedPath =
        artifact.path === "/"
          ? url.pathname
          : url.pathname.slice(artifact.path.length - 1) || "/";

      const distDir = `${artifact.entryDir}/dist`;
      let filePath = `${distDir}${strippedPath}`;

      const file = Bun.file(filePath);
      if (!(await file.exists())) filePath = `${distDir}/index.html`;

      return new Response(Bun.file(filePath));
    }

    // DEV MODE — proxy to Vite dev server
    const upstream = `http://localhost:${artifact.localPort}`;
    const upstreamPath =
      artifact.path === "/"
        ? url.pathname
        : url.pathname.slice(artifact.path.length - 1) || "/";

    return fetch(`${upstream}${upstreamPath}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
  },

  websocket: {
    async open(ws) {
      const { port, path } = ws.data;
      const upstream = new WebSocket(`ws://localhost:${port}${path}`);
      upstream.onmessage = (e) => ws.send(e.data);
      upstream.onclose = () => ws.close();
      ws.data.upstream = upstream;
    },
    message(ws, msg) {
      ws.data.upstream?.send(msg);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});

console.log(`[router] listening on :3000 (${IS_PROD ? "prod" : "dev"} mode)`);
