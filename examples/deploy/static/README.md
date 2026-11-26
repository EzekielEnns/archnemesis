# The static build on any static host

`pnpm build:static` writes `dist-static/`: the app with no server. Designs are kept in the
browser (IndexedDB), so each visitor has their own, nothing is shared, and nothing leaves the
page. It works with WebMCP (`src/webmcp.ts`) for an agent that runs in the browser. There is
no MCP URL, no sign-in, no git and no live sync between people. Use it for a free public
demo.

```sh
pnpm install
pnpm build:static
# upload the contents of dist-static/ to any static host
```

To look at it locally:

```sh
pnpm exec vite preview --outDir dist-static
```

## Any static host

Serve `dist-static/` as it is. Its base is relative (`vite.config.ts`), so it works at the
root of a domain or under any path, with no setting to change. Send `index.html` for the
root; the app has no server routes.

## GitHub Pages

Publish the contents of `dist-static/` to the branch or folder Pages serves, or upload it
with a Pages workflow. A project site is served under `/<repo>/`; the relative
base means that needs nothing extra.

## Cloudflare Pages

Create a Pages project, then upload `dist-static/` (direct upload, or a build command of
`pnpm build:static` with the output directory `dist-static`). Check the current Pages docs
for the exact settings.
