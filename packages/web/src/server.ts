import { listSessions, getSession } from "@ralphbox/core/session";
import { serve } from "bun";
import index from "./index.html";

const server = serve({
  port: Number(process.env.PORT) || 8642,
  routes: {
    "/*": index,

    "/api/sessions": {
      async GET() {
        const sessions = await listSessions();
        return Response.json(sessions);
      },
    },

    "/api/sessions/:id": async (req) => {
      const session = await getSession(req.params.id);
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      return Response.json(session);
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
