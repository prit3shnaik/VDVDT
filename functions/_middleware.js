const DEFAULT_DSN =
  "https://42133951c940599c21a9bc25cf8052e3@o4511706903805952.ingest.us.sentry.io/4511706911670272";

function parseDsn(dsn) {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, "");

    if (!publicKey || !projectId) {
      return null;
    }

    return {
      publicKey,
      storeEndpoint: `${url.origin}/api/${projectId}/store/`,
    };
  } catch {
    return null;
  }
}

async function reportToSentry(dsn, context, error) {
  const parsed = parseDsn(dsn);
  if (!parsed) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const request = context.request;

  const event = {
    event_id: crypto.randomUUID().replaceAll("-", ""),
    level: "error",
    platform: "javascript",
    message,
    timestamp: new Date().toISOString(),
    request: {
      url: request.url,
      method: request.method,
      headers: {
        "user-agent": request.headers.get("user-agent") || "",
      },
    },
    extra: {
      stack,
    },
  };

  const authHeader =
    `Sentry sentry_version=7, sentry_client=cf-pages-manual/1.0, sentry_key=${parsed.publicKey}`;

  try {
    await fetch(parsed.storeEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": authHeader,
      },
      body: JSON.stringify(event),
    });
  } catch {
    // Never interrupt request handling if Sentry reporting fails.
  }
}

// Paths owned by Pages Functions. A 404 from these is a real 404 (e.g. unknown API
// route) and must NOT be rewritten to the SPA shell.
const FUNCTION_PREFIXES = ["/api/", "/media/", "/rest/", "/storage/"];

function isSpaNavigation(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const url = new URL(request.url);
  if (FUNCTION_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    return false;
  }

  // Only rewrite document navigations, never asset or data fetches — rewriting a
  // missing .js/.css to HTML causes confusing MIME type errors instead of a clean 404.
  const accept = request.headers.get("accept") || "";
  if (!accept.includes("text/html")) {
    return false;
  }

  return !/\.[a-z0-9]+$/i.test(url.pathname);
}

export async function onRequest(context) {
  try {
    const response = await context.next();

    // Client-side routes (/login, /voters, ...) have no matching asset, so Pages
    // returns 404. Serve the SPA shell for those so deep links and refreshes work.
    if (response.status === 404 && isSpaNavigation(context.request)) {
      const url = new URL(context.request.url);

      // Fetch the shell with a clean GET. Forwarding the original request's conditional
      // headers (If-None-Match / If-Modified-Since) would yield a bodyless 304, which
      // then gets rewritten to a 200 with an empty body — a blank page.
      const shell = await context.env.ASSETS.fetch(
        new Request(`${url.origin}/index.html`, { method: "GET" })
      );

      if (!shell.ok) {
        return response;
      }

      const headers = new Headers(shell.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      // The shell is route-dependent output; don't let it be cached as a static asset.
      headers.set("cache-control", "no-cache");
      headers.delete("etag");
      headers.delete("last-modified");

      return new Response(shell.body, { status: 200, headers });
    }

    return response;
  } catch (error) {
    const dsn = context.env.SENTRY_DSN || DEFAULT_DSN;
    await reportToSentry(dsn, context, error);
    throw error;
  }
}
