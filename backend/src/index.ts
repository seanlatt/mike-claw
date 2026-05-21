import "dotenv/config";
import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { openclawRouter } from "./routes/openclaw";
import { openclawToolsRouter } from "./routes/openclawTools";
import { openclawIntakeRouter } from "./routes/openclawIntake";
import { checkOpenClawHealth } from "./lib/openclaw/health";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));

// Log every non-2xx response so we don't lose debugging info when
// Supabase or downstream errors bubble up as JSON detail messages.
app.use((req, res, next) => {
  const start = Date.now();
  const origSend = res.send.bind(res);
  res.send = function (body: unknown) {
    if (res.statusCode >= 400) {
      const summary =
        typeof body === "string"
          ? body.slice(0, 300)
          : JSON.stringify(body).slice(0, 300);
      console.warn(
        `[${res.statusCode}] ${req.method} ${req.originalUrl} (${Date.now() - start}ms) ${summary}`,
      );
    }
    return origSend(body);
  };
  next();
});

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/openclaw", openclawRouter);
app.use("/openclaw/tools", openclawToolsRouter);
app.use("/openclaw/intake", openclawIntakeRouter);

app.get("/health/openclaw", async (_req, res) => {
  const health = await checkOpenClawHealth();
  res.status(health.ok ? 200 : 503).json(health);
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Debug: who am I + what projects exist for me? Useful when the UI claims
// no projects but the DB shows rows.
import { requireAuth as _requireAuthDebug } from "./middleware/auth";
import { createServerSupabase as _createSupaDebug } from "./lib/supabase";
app.get("/debug/me", _requireAuthDebug, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const db = _createSupaDebug();
  const { data: own } = await db
    .from("projects")
    .select("id, name, user_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  const { data: shared } = userEmail
    ? await db
        .from("projects")
        .select("id, name, user_id, created_at")
        // shared_with is jsonb — JSON-stringify the array for containment.
        .contains("shared_with", JSON.stringify([userEmail]))
        .neq("user_id", userId)
    : { data: [] };
  res.json({
    backend_sees: { userId, userEmail },
    own_projects: own ?? [],
    shared_projects: shared ?? [],
    project_count: (own ?? []).length + (shared ?? []).length,
  });
});

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});
