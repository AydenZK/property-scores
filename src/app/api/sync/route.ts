import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const runtime = "nodejs";

const redis =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      })
    : null;

const KEY_NAMESPACE = "property_scorecard_v1";
const MAX_SYNC_KEY_LENGTH = 128;

type SyncAction = "pull" | "push";

interface CloudRecord {
  schemaVersion: number;
  updatedAt: number;
  state: unknown;
}

function getStoreKey(syncKey: string): string {
  const hashed = crypto.createHash("sha256").update(syncKey).digest("hex");
  return `${KEY_NAMESPACE}:${hashed}`;
}

function badRequest(message: string) {
  return NextResponse.json({ ok: false, message }, { status: 400 });
}

export async function POST(request: NextRequest) {
  if (!redis) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Cloud sync is not configured on the server. Add KV_REST_API_URL and KV_REST_API_TOKEN.",
      },
      { status: 500 },
    );
  }

  try {
    const body = (await request.json()) as {
      action?: SyncAction;
      syncKey?: string;
      payload?: CloudRecord;
    };

    const action = body.action;
    const syncKey = body.syncKey?.trim();

    if (!action || (action !== "pull" && action !== "push")) {
      return badRequest("Invalid sync action.");
    }
    if (!syncKey) return badRequest("Sync key is required.");
    if (syncKey.length > MAX_SYNC_KEY_LENGTH) {
      return badRequest(`Sync key must be ${MAX_SYNC_KEY_LENGTH} chars or less.`);
    }

    const storeKey = getStoreKey(syncKey);

    if (action === "pull") {
      const record = await redis.get<CloudRecord>(storeKey);
      return NextResponse.json({ ok: true, record: record ?? null });
    }

    if (!body.payload) return badRequest("Payload is required for push.");
    const { schemaVersion, updatedAt, state } = body.payload;
    if (typeof schemaVersion !== "number" || typeof updatedAt !== "number") {
      return badRequest("Payload metadata is invalid.");
    }

    const record: CloudRecord = { schemaVersion, updatedAt, state };
    await redis.set(storeKey, record);
    return NextResponse.json({ ok: true, record });
  } catch {
    return NextResponse.json(
      { ok: false, message: "Sync request failed." },
      { status: 500 },
    );
  }
}
