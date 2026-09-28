// app/api/roboflow/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { LABS_ENABLED } from '@/lib/config/labs';

// ── Guard rails ───────────────────────────────────────────────────────────────
// This proxy spends your Roboflow credits, so it is:
//   • disabled in production unless NEXT_PUBLIC_ENABLE_LABS=true
//   • restricted to the workspaces / models listed in env (comma-separated)
//   • size-limited so nobody can push huge payloads through it
const MAX_BASE64_CHARS = 12 * 1024 * 1024; // ~9 MB image
const ALLOWED_WORKSPACES = (process.env.ROBOFLOW_ALLOWED_WORKSPACES ?? '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_MODELS     = (process.env.ROBOFLOW_ALLOWED_MODELS     ?? '').split(',').map(s => s.trim()).filter(Boolean);
const SAFE_ID = /^[a-zA-Z0-9_./-]{1,120}$/;
const DEBUG = process.env.ROBOFLOW_DEBUG === 'true';

const MODEL_API_KEY    = process.env.ROBOFLOW_API_KEY          ?? '';
const WORKFLOW_API_KEY = process.env.ROBOFLOW_WORKFLOW_API_KEY ?? MODEL_API_KEY;


export async function POST(req: NextRequest) {
  if (!LABS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!MODEL_API_KEY) return NextResponse.json({ error: 'Roboflow is not configured' }, { status: 503 });
  try {
    const body = await req.json();
    if (typeof body?.base64 !== 'string' || body.base64.length === 0 || body.base64.length > MAX_BASE64_CHARS) {
      return NextResponse.json({ error: 'base64 image missing or too large' }, { status: 413 });
    }
    if (body.type === 'workflow') {
      if (!SAFE_ID.test(String(body.workspaceSlug)) || !SAFE_ID.test(String(body.workflowId))) {
        return NextResponse.json({ error: 'Invalid workflow id' }, { status: 400 });
      }
      if (ALLOWED_WORKSPACES.length && !ALLOWED_WORKSPACES.includes(body.workspaceSlug)) {
        return NextResponse.json({ error: 'Workspace not allowed' }, { status: 403 });
      }
      return proxyWorkflow(body);
    }
    if (body.type === 'model') {
      if (!SAFE_ID.test(String(body.id)) || !['serverless', 'detect', 'segment', 'classify'].includes(body.baseUrl)) {
        return NextResponse.json({ error: 'Invalid model id' }, { status: 400 });
      }
      if (ALLOWED_MODELS.length && !ALLOWED_MODELS.includes(body.id)) {
        return NextResponse.json({ error: 'Model not allowed' }, { status: 403 });
      }
      return proxyModel(body);
    }
    return NextResponse.json({ error: 'Unknown proxy type' }, { status: 400 });
  } catch (err: any) {
    console.error('[roboflow-proxy] Error:', err.message);
    return NextResponse.json({ error: 'Proxy request failed' }, { status: 500 });
  }
}

// ─── Workflow proxy ──────────────────────────────────────────────────────────
//
// Roboflow workflows require a public image URL, not raw base64.
// Strategy:
//   Attempt 1 — send as data URI (zero extra requests, works on many nodes)
//   Attempt 2 — upload to imgbb and pass the public URL
//
// The raw workflow response is returned as-is so detectRooms can log and
// parse it. We no longer try to extract predictions here — that is the
// caller's responsibility.

async function proxyWorkflow(body: {
  workspaceSlug: string;
  workflowId:    string;
  base64:        string;
  classes:       string;
}) {
  const workflowUrl =
    `https://serverless.roboflow.com/${body.workspaceSlug}/workflows/${body.workflowId}`;

  // ── Attempt 1: data URI ────────────────────────────────────────────────
  const dataUri = `data:image/jpeg;base64,${body.base64}`;
  DEBUG && console.log(`[roboflow-proxy] workflow attempt 1: data URI`);

  const attempt1 = await fetchWorkflow(workflowUrl, dataUri, body.classes);
  if (attempt1.ok) {
    const data = await attempt1.json();
    DEBUG && console.log('[roboflow-proxy] ✅ workflow succeeded with data URI');
    DEBUG && console.log('[roboflow-proxy] workflow output[0] keys:', Object.keys(data?.outputs?.[0] ?? {}));
    DEBUG && console.log('[roboflow-proxy] workflow output[0].predictions:', JSON.stringify(data?.outputs?.[0]?.predictions ?? null, null, 2));
    return NextResponse.json(data);
  }

  const err1Text = await attempt1.text().catch(() => attempt1.statusText);
  console.warn(`[roboflow-proxy] data URI attempt failed ${attempt1.status}:`, err1Text);

  // ── Attempt 2: imgbb upload ────────────────────────────────────────────
  const IMGBB_KEY = process.env.IMGBB_API_KEY ?? '';
  if (!IMGBB_KEY) {
    console.error('[roboflow-proxy] IMGBB_API_KEY not set — cannot upload image for workflow');
    return NextResponse.json(
      { error: 'Workflow requires a public image URL. Set IMGBB_API_KEY in .env.local.' },
      { status: 500 },
    );
  }

  let imageUrl: string;
  try {
    DEBUG && console.log(`[roboflow-proxy] workflow attempt 2: uploading to imgbb…`);
    imageUrl = await uploadToImgbb(body.base64, IMGBB_KEY);
    DEBUG && console.log(`[roboflow-proxy] imgbb URL → ${imageUrl}`);
  } catch (uploadErr: any) {
    console.error('[roboflow-proxy] imgbb upload failed:', uploadErr.message);
    return NextResponse.json({ error: `imgbb upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  const attempt2 = await fetchWorkflow(workflowUrl, imageUrl, body.classes);
  const data2    = await attempt2.json();

  if (!attempt2.ok) {
    console.error(`[roboflow-proxy] workflow attempt 2 → ${attempt2.status}`, data2);
    return NextResponse.json(data2, { status: attempt2.status });
  }

  DEBUG && console.log('[roboflow-proxy] ✅ workflow succeeded with imgbb URL');
  DEBUG && console.log('[roboflow-proxy] workflow output[0] keys:', Object.keys(data2?.outputs?.[0] ?? {}));
  DEBUG && console.log('[roboflow-proxy] workflow output[0].predictions:', JSON.stringify(data2?.outputs?.[0]?.predictions ?? null, null, 2));
  return NextResponse.json(data2);
}

async function fetchWorkflow(url: string, imageValue: string, classes: string) {
  return fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      api_key: WORKFLOW_API_KEY,
      inputs: {
        image:   { type: 'url', value: imageValue },
        classes: classes,
      },
    }),
  });
}

// ─── imgbb upload ────────────────────────────────────────────────────────────

async function uploadToImgbb(base64: string, apiKey: string): Promise<string> {
  const form = new URLSearchParams();
  form.append('key',        apiKey);
  form.append('image',      base64);
  form.append('expiration', '600'); // 10 minutes

  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body:   form,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`imgbb upload failed ${res.status}: ${msg}`);
  }

  const data = await res.json();
  const url  = data?.data?.url as string | undefined;
  if (!url) throw new Error(`imgbb: no URL in response: ${JSON.stringify(data)}`);
  return url;
}

// ─── Standard model proxy ────────────────────────────────────────────────────

async function proxyModel(body: {
  id:          string;
  base64:      string;
  baseUrl:     'serverless' | 'detect' | 'segment' | 'classify';
  confidence?: number;   // 0–1 (e.g. 0.10) — converted to 0–100 for Roboflow
  overlap?:    number;   // 0–1 (e.g. 0.45) — converted to 0–100 for Roboflow
}) {
  const baseUrls: Record<string, string> = {
    serverless: 'https://serverless.roboflow.com',
    detect:     'https://detect.roboflow.com',
    segment:    'https://segment.roboflow.com',
    classify:   'https://classify.roboflow.com',
  };

  // Roboflow expects confidence and overlap as integers in the 0–100 range.
  // We clamp and round so a caller passing 0.10 becomes ?confidence=10.
  const confidenceParam = Math.round(Math.max(0, Math.min(1, body.confidence ?? 0.10)) * 100);
  const overlapParam    = Math.round(Math.max(0, Math.min(1, body.overlap    ?? 0.30)) * 100);

  const url = `${baseUrls[body.baseUrl]}/${body.id}`
      + `?api_key=${encodeURIComponent(MODEL_API_KEY)}`
      + `&confidence=${confidenceParam}`
      + `&overlap=${overlapParam}`
      + `&max_detections=500`
      + `&class_agnostic_nms=true`;

  DEBUG && console.log(`[roboflow-proxy] model ${body.id} confidence=${confidenceParam}% overlap=${overlapParam}%`);

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.base64,
  });

  const data = await res.json();

  if (!res.ok) {
    console.error(`[roboflow-proxy] model ${body.id} → ${res.status}`, data);
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json(data);
}