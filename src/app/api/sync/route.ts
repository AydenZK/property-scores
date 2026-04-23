import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "redis";

export const runtime = "nodejs";

const redisUrl = process.env.REDIS_URL ?? "";
const redis = redisUrl ? createClient({ url: redisUrl }) : null;
let redisConnected = false;

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
        message: "Cloud sync is not configured on the server. Add REDIS_URL.",
      },
      { status: 500 },
    );
  }

  try {
    if (!redisConnected) {
      await redis.connect();
      redisConnected = true;
    }

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
      const raw = await redis.get(storeKey);
      const record = typeof raw === "string" ? (JSON.parse(raw) as CloudRecord) : null;
      return NextResponse.json({ ok: true, record: record ?? null });
    }

    if (!body.payload) return badRequest("Payload is required for push.");
    const { schemaVersion, updatedAt, state } = body.payload;
    if (typeof schemaVersion !== "number" || typeof updatedAt !== "number") {
      return badRequest("Payload metadata is invalid.");
    }

    const record: CloudRecord = { schemaVersion, updatedAt, state };
    await redis.set(storeKey, JSON.stringify(record));
    return NextResponse.json({ ok: true, record });
  } catch {
    return NextResponse.json(
      { ok: false, message: "Sync request failed." },
      { status: 500 },
    );
  }
}
