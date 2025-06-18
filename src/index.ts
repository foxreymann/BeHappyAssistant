import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { HTTPException } from "hono/http-exception";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  ANTHROPIC_API_KEY: string;
};

type Variables = {
  userId: number;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Middleware to verify JWT token
const authMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  try {
    const payload = await verify(token, c.env.JWT_SECRET);
    c.set('userId', payload.userId);
    await next();
  } catch (error) {
    throw new HTTPException(401, { message: 'Invalid token' });
  }
};

app.get("/", (c) => {
  return c.text("Personal Happiness Assistant API");
});

// Authentication endpoint
app.post("/auth/login", async (c) => {
  const db = drizzle(c.env.DB);
  const { email, name } = await c.req.json();

  if (!email) {
    return c.json({ error: "Email is required" }, 400);
  }

  try {
    // Check if user exists
    let [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));

    // Create user if doesn't exist
    if (!user) {
      [user] = await db.insert(schema.users).values({
        email,
        name: name || null,
      }).returning();
    }

    // Generate JWT token
    const token = await sign({ userId: user.id }, c.env.JWT_SECRET);

    return c.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    return c.json({ error: "Login failed" }, 500);
  }
});

// Submit entry and get AI recommendation
app.post("/entries", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const { content } = await c.req.json();

  if (!content) {
    return c.json({ error: "Content is required" }, 400);
  }

  try {
    // Get user context for personalized recommendations
    const userContextData = await db.select()
      .from(schema.userContext)
      .where(eq(schema.userContext.userId, userId));

    // Get recent entries for context
    const recentEntries = await db.select()
      .from(schema.userEntries)
      .where(eq(schema.userEntries.userId, userId))
      .orderBy(desc(schema.userEntries.createdAt))
      .limit(5);

    // Build context for AI
    const contextString = userContextData.map(ctx => `${ctx.contextKey}: ${ctx.contextValue}`).join(', ');
    const historyString = recentEntries.map(entry => `User: ${entry.content}\nAI: ${entry.aiResponse}`).join('\n\n');

    // Generate AI response using Claude
    const aiPrompt = `You are a personal well-being assistant focused on helping people become happier. 

User Context: ${contextString || 'No specific context available'}

Recent conversation history:
${historyString || 'No previous conversations'}

Current user input: "${content}"

Please provide personalized, actionable advice to help this person improve their well-being and happiness. Be empathetic, specific, and solution-focused. Consider their unique circumstances and history.`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: aiPrompt
          }
        ]
      })
    });

    if (!aiResponse.ok) {
      throw new Error('AI service unavailable');
    }

    const aiData = await aiResponse.json() as { content: Array<{ text: string }> };
    const recommendation = aiData.content[0].text;

    // Save entry with AI response
    const [newEntry] = await db.insert(schema.userEntries).values({
      userId,
      content,
      aiResponse: recommendation,
    }).returning();

    return c.json({
      entry: newEntry,
      recommendation
    });
  } catch (error) {
    return c.json({ error: "Failed to generate recommendation" }, 500);
  }
});

// Get user's entry history
app.get("/entries", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const limit = Number.parseInt(c.req.query('limit') || '20');
  const offset = Number.parseInt(c.req.query('offset') || '0');

  try {
    const entries = await db.select()
      .from(schema.userEntries)
      .where(eq(schema.userEntries.userId, userId))
      .orderBy(desc(schema.userEntries.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ entries });
  } catch (error) {
    return c.json({ error: "Failed to fetch entries" }, 500);
  }
});

// Get user profile and context
app.get("/profile", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');

  try {
    const [user] = await db.select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    const contextData = await db.select()
      .from(schema.userContext)
      .where(eq(schema.userContext.userId, userId));

    // Group context by key
    const context: Record<string, string[]> = {};
    contextData.forEach(item => {
      if (!context[item.contextKey]) {
        context[item.contextKey] = [];
      }
      context[item.contextKey].push(item.contextValue);
    });

    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      context
    });
  } catch (error) {
    return c.json({ error: "Failed to fetch profile" }, 500);
  }
});

// Update user context
app.put("/profile", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get('userId');
  const contextUpdates = await c.req.json();

  try {
    // Clear existing context for this user
    await db.delete(schema.userContext)
      .where(eq(schema.userContext.userId, userId));

    // Insert new context data
    const contextEntries = [];
    for (const [key, values] of Object.entries(contextUpdates)) {
      if (Array.isArray(values)) {
        for (const value of values) {
          contextEntries.push({
            userId,
            contextKey: key,
            contextValue: value
          });
        }
      } else {
        contextEntries.push({
          userId,
          contextKey: key,
          contextValue: String(values)
        });
      }
    }

    if (contextEntries.length > 0) {
      await db.insert(schema.userContext).values(contextEntries);
    }

    return c.json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    return c.json({ error: "Failed to update profile" }, 500);
  }
});

/**
 * Serve a simplified api specification for your API
 * As of writing, this is just the list of routes and their methods.
 */
app.get("/openapi.json", c => {
  return c.json(createOpenAPISpec(app, {
    info: {
      title: "Personal Happiness Assistant API",
      version: "1.0.0",
    },
  }))
});

/**
 * Mount the Fiberplane api explorer to be able to make requests against your API.
 *
 * Visit the explorer at `/fp`
 */
app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" }
}));

export default app;