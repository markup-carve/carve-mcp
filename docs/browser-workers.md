# Browser workers and Content Security Policy

Run the MCP client in a module worker when an editor or preview must keep the
main thread responsive. Initialization is asynchronous: do not accept work
until `client.connect()` has resolved, and share that one promise between
messages so concurrent first requests cannot create several sessions.

```ts
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client/streamableHttp.js'

let ready: Promise<Client> | undefined

function initialize(): Promise<Client> {
  ready ??= (async () => {
    const client = new Client({ name: 'carve-worker', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL('/mcp', self.location.origin),
    )
    await client.connect(transport)
    return client
  })()
  return ready
}

self.onmessage = async ({ data }) => {
  try {
    const client = await initialize()
    const result = await client.callTool(data)
    self.postMessage({ id: data.id, result })
  } catch (error) {
    ready = undefined
    self.postMessage({ id: data.id, error: String(error) })
  }
}
```

Serve the worker and its dependencies as files. Carve MCP does not require
`unsafe-eval`, inline scripts, blob workers, or WebAssembly. A restrictive
starting policy for a same-origin deployment is:

```http
Content-Security-Policy: default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'
```

If the MCP endpoint is on another origin, add that exact HTTPS origin to
`connect-src`. The current server deliberately does not emit permissive CORS
headers, so put a same-origin reverse proxy in front of it rather than exposing
a bearer token to arbitrary browser origins. Set `CARVE_MCP_ALLOWED_HOSTS` to
the public host seen by the server and terminate TLS at the proxy. Never embed
a long-lived shared bearer token in shipped browser JavaScript; use a
same-origin authenticated gateway with short-lived user credentials.

The source-patch fingerprint is a stale-edit guard, not a trust boundary.
Review the returned edit kind and code before applying a patch, and never apply
an `unresolved` suggestion automatically.
